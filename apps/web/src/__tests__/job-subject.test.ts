import { describe, expect, it } from 'vitest';
import '../i18n/config';
import { jobSubject, jobSubjectUrl } from '../shared/lib/job-subject';
import type { JobView } from '../types/api';

const ASSET = '3f2b8c1e-0000-4000-8000-000000000001';

function job(type: JobView['type'], payload: unknown, owner = 'studio'): JobView {
  return {
    id: 'job-1',
    owner,
    type,
    lane: 'batch',
    status: 'completed',
    priority: 0,
    correlation_id: 'c',
    affinity_key: null,
    group_key: null,
    attempt_count: 1,
    max_attempts: 3,
    node_id: null,
    progress_percent: null,
    progress_stage: null,
    result: null,
    error: null,
    created_at: '2026-10-28T10:00:00.000Z',
    updated_at: '2026-10-28T10:00:00.000Z',
    finished_at: null,
    acked_at: null,
    payload,
  };
}

describe('jobSubject', () => {
  it('job quét: video theo asset id, tên file khi có', () => {
    const extract = jobSubject(job('scan.extract', { asset: { id: ASSET, kind: 'video' } }, 'ag-go'))!;
    expect(extract.label).toBe('Video 3f2b8c1e…');
    expect(extract.assetId).toBe(ASSET);

    const ai = jobSubject(job('scan.ai', { asset_id: ASSET, context: { asset_name: 'cho-ben-thanh.mp4' } }, 'ag-go'))!;
    expect(ai.label).toBe('cho-ben-thanh.mp4');
    expect(ai.detail).toBe(`cho-ben-thanh.mp4 (${ASSET})`);
  });

  it('job render: dự án, bản dựng và video Studio lấy từ output', () => {
    const s = jobSubject(
      job('studio.render_final', { production_id: 'p42', revision: 7, output: 'videos/v9/final/job-1.mp4' }),
    )!;
    expect(s.label).toBe('Dự án p42 · bản 7');
    expect(s.studioVideoId).toBe('v9');
    expect(s.detail).toBe('p42 · videos/v9/final/job-1.mp4');
  });

  it('payload không cho biết video nào thì không có', () => {
    expect(jobSubject(job('scan.extract', {}))).toBeNull();
    expect(jobSubject(job('studio.tts', undefined))).toBeNull();
  });
});

describe('jobSubjectUrl', () => {
  it('Studio: domain + /p/<dự án>/v/<video>, không có video thì trang dự án', () => {
    const render = jobSubject(job('studio.render_final', { production_id: 'p42', revision: 7, output: 'videos/v9/final/j.mp4' }))!;
    expect(jobSubjectUrl('studio', render, 'https://studio.example.com/')).toBe(
      'https://studio.example.com/p/p42/v/v9?tab=preview',
    );
    const tts = jobSubject(job('studio.tts', { production_id: 'p42' }))!;
    expect(jobSubjectUrl('studio', tts, 'https://studio.example.com')).toBe('https://studio.example.com/p/p42');
  });

  it('ag-go: domain + /footage?asset=<id>', () => {
    const scan = jobSubject(job('scan.extract', { asset: { id: ASSET, kind: 'video' } }, 'ag-go'))!;
    expect(jobSubjectUrl('ag-go', scan, 'https://go.example.com')).toBe(`https://go.example.com/footage?asset=${ASSET}`);
  });

  it('chưa nhập domain, hoặc job không có video để mở: không có link', () => {
    const tts = jobSubject(job('studio.tts', { production_id: 'p42' }))!;
    expect(jobSubjectUrl('studio', tts, null)).toBeNull();
    // ag-go gửi studio.transcribe với production_id là id của ag-go: không ghép đường dẫn Studio.
    const prep = jobSubject(job('studio.transcribe', { production_id: 'prep-1' }, 'ag-go'))!;
    expect(jobSubjectUrl('ag-go', prep, 'https://go.example.com')).toBeNull();
  });

  it('tải video tham chiếu: link thẳng tới YouTube', () => {
    const s = jobSubject(job('studio.reference_fetch', { production_id: 'p1', video_id: 'dQw4w9WgXcQ' }))!;
    expect(s.label).toBe('YouTube dQw4w9WgXcQ');
    expect(jobSubjectUrl('studio', s, null)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
