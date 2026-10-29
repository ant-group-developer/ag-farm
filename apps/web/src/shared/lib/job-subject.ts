import i18n from 'i18next';
import type { JobView } from '../../types/api';

export interface JobSubject {
  /** Tên ngắn của video / dự án mà job quét hoặc dựng. */
  label: string;
  /** Mô tả đầy đủ (id đầy đủ, file kết quả…) cho tooltip. */
  detail: string;
  assetId: string | null;
  productionId: string | null;
  /** Video của Studio mà job dựng, lấy từ `output` (`videos/<id>/final/<job>.mp4`). */
  studioVideoId: string | null;
  /** Video YouTube của `studio.reference_fetch`: link thẳng, không cần trang của ứng dụng. */
  youtubeId: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

/** Video / dự án mà job làm việc, đọc từ payload; `null` khi payload không cho biết (loại lạ, payload cũ). */
export function jobSubject(job: JobView): JobSubject | null {
  const p = obj(job.payload);
  const none = { assetId: null, productionId: null, studioVideoId: null, youtubeId: null };

  if (job.type.startsWith('scan.')) {
    const asset = obj(p.asset);
    const assetId = str(asset.id) ?? str(p.asset_id);
    if (!assetId) return null;
    const name = str(obj(p.context).asset_name);
    const key = asset.kind === 'image' ? 'jobs.subjectImage' : 'jobs.subjectVideo';
    return {
      ...none,
      label: name ?? i18n.t(key, { id: short(assetId) }),
      detail: name ? `${name} (${assetId})` : assetId,
      assetId,
    };
  }

  const productionId = str(p.production_id);
  if (!productionId) return null;
  const output = str(p.output);
  const youtubeId = str(p.video_id);
  let label = youtubeId ? `YouTube ${youtubeId}` : i18n.t('jobs.subjectProduction', { id: short(productionId) });
  const revision = str(p.revision);
  if (revision && !youtubeId) label += ` · ${i18n.t('jobs.subjectRevision', { revision })}`;
  return {
    ...none,
    label,
    detail: [productionId, output].filter(Boolean).join(' · '),
    productionId,
    studioVideoId: output?.match(/^videos\/([^/]+)\//)?.[1] ?? null,
    youtubeId,
  };
}

/**
 * Đường dẫn trang trong web của từng ứng dụng, theo id ứng dụng (chủ job); admin chỉ nhập domain (`web_url`).
 * Đường dẫn chọn theo ứng dụng chứ không theo loại job: ag-go cũng gửi `studio.transcribe`, với `production_id` là id
 * bản chuẩn bị của ag-go chứ không phải dự án Studio.
 */
const APP_PATHS: Record<string, (s: JobSubject) => string | null> = {
  // ag-studio `apps/web/src/App.tsx`: `/p/:projectId`, `/p/:projectId/v/:videoId` (tab Xem trước); `production_id` của
  // job là id dự án (`packages/studio-engine`: `production_id: job.project_id`).
  studio: (s) => {
    if (!s.productionId) return null;
    const project = `/p/${encodeURIComponent(s.productionId)}`;
    return s.studioVideoId ? `${project}/v/${encodeURIComponent(s.studioVideoId)}?tab=preview` : project;
  },
  // ag-go-web `footage-page.tsx`: `?asset=<id>` mở drawer của video đó. Job `studio.transcribe` của ag-go không có
  // asset (chỉ `production_id` là id bản chuẩn bị) nên không có link.
  'ag-go': (s) => (s.assetId ? `/footage?asset=${encodeURIComponent(s.assetId)}` : null),
};

/** Link mở video / dự án của job: video YouTube, hoặc trang của ứng dụng trên domain admin đã nhập. */
export function jobSubjectUrl(owner: string, subject: JobSubject, webUrl: string | null | undefined): string | null {
  if (subject.youtubeId) return `https://www.youtube.com/watch?v=${encodeURIComponent(subject.youtubeId)}`;
  const path = webUrl ? APP_PATHS[owner]?.(subject) : null;
  return path ? `${webUrl!.replace(/\/+$/, '')}${path}` : null;
}
