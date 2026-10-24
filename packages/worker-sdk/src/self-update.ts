/**
 * Worker tự cập nhật (máy cài bằng install.ps1):
 *
 * 1. Mỗi `update_check_minutes` (mặc định 15, lệch ngẫu nhiên ±20 % để các máy không hỏi cùng lúc) đọc
 *    `<hub>/dist/latest.json`; mỗi phút hỏi `GET /v1/worker/me` xem admin có cho tự cập nhật (`auto_update`) hay vừa
 *    bấm "Cập nhật ngay" (`update_requested_at`, khi đó kiểm ngay).
 * 2. Có bản mới hơn của gói mình và được phép: ngừng nhận việc (`draining`), chờ việc đang chạy xong, tối đa
 *    `update_drain_minutes` (mặc định 240: một bản cuối 4K chạy 40–60 phút, 30 phút cũ cắt ngang nó). Quá hạn mà việc
 *    còn chạy thì trả việc về hub (`fail` retryable, `worker_updating`) để máy khác nhận ngay, rồi mới cập nhật.
 * 3. Ghi `<updater_dir>/request-<role>.json` rồi chạy task `updater_task` (`ag-farm-updater`, SYSTEM): task dừng
 *    worker, cài bản mới (giữ `app.prev`), chạy setup, ghi config, bật lại; bản mới không heartbeat trong 3 phút thì
 *    quay về `app.prev`. Task ghi kết quả vào `<updater_dir>/result-<role>.json`; worker đọc nó lúc khởi động và báo
 *    hub qua heartbeat (`update`).
 *
 * Bản đã cập nhật hỏng không tự thử lại (máy sẽ ngừng nhận việc mỗi 15 phút); admin bấm "Cập nhật ngay" để thử lại.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_PACKAGES, ReleaseEntrySchema, compareVersions } from '@ag-farm/protocol';
import type { WorkerMeResponse, WorkerUpdateStatus } from '@ag-farm/protocol';
import type { Logger } from './logger';

export const UPDATE_CHECK_MINUTES_DEFAULT = 15;
export const UPDATE_DRAIN_MINUTES_DEFAULT = 240;
/** "Cập nhật ngay" cũ hơn chừng này thì bỏ (vd. bấm lúc máy tắt, bật lại sau một tuần). */
const UPDATE_REQUEST_TTL_MS = 60 * 60_000;
const HUB_TIMEOUT_MS = 30_000;

/** Kết quả một lần cập nhật, do updater (install.ps1) ghi. */
export interface UpdateOutcome {
  state: 'done' | 'failed';
  from_version?: string;
  target_version?: string;
  message?: string;
  finished_at?: string;
  /** `requested_at` của yêu cầu đã xử lý (để không xử lý lại một lần bấm "Cập nhật ngay"). */
  requested_at?: string;
}

/** Yêu cầu worker gửi updater. */
export interface UpdateRequest {
  package: string;
  from_version: string;
  target_version: string;
  reason: 'auto' | 'requested';
  requested_at: string;
}

/** Tên vai trò (`render`, `scan`) của một gói: đặt tên file yêu cầu/kết quả giống install.ps1. */
export function updateRole(packageName: string): string {
  for (const [role, pkg] of Object.entries(ROLE_PACKAGES)) if (pkg === packageName) return role;
  return packageName;
}

export function readUpdateOutcome(dir: string, role: string): UpdateOutcome | null {
  try {
    // install.ps1 (PowerShell 5.1) có thể ghi kèm BOM
    const raw = JSON.parse(readFileSync(join(dir, `result-${role}.json`), 'utf8').replace(/^\uFEFF/, '')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o['state'] !== 'done' && o['state'] !== 'failed') return null;
    const str = (k: string) => (typeof o[k] === 'string' && o[k] ? String(o[k]) : undefined);
    return {
      state: o['state'],
      from_version: str('from_version'),
      target_version: str('target_version'),
      message: str('message'),
      finished_at: str('finished_at'),
      requested_at: str('requested_at'),
    };
  } catch {
    return null;
  }
}

/** Ghi qua file tạm rồi đổi tên: updater không bao giờ đọc nửa file. */
export function writeUpdateRequest(dir: string, role: string, req: UpdateRequest): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `request-${role}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(req, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Chạy một task của Task Scheduler (worker chạy dưới SYSTEM nên chạy được task SYSTEM). */
export function startScheduledTask(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', ['/Run', '/TN', name], { timeout: 30_000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`schtasks /Run ${name} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}

/** Phiên bản mới nhất của `packageName` trong `<hub>/dist/latest.json`, hoặc null nếu hub chưa phát hành gói này. */
export async function fetchLatestVersion(hubUrl: string, packageName: string): Promise<string | null> {
  const res = await fetch(`${hubUrl.replace(/\/$/, '')}/dist/latest.json`, {
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET /dist/latest.json failed: HTTP ${res.status}`);
  const raw = JSON.parse((await res.text()).replace(/^\uFEFF/, '')) as { packages?: Record<string, unknown> };
  const entry = ReleaseEntrySchema.safeParse(raw?.packages?.[packageName]);
  return entry.success ? entry.data.version : null;
}

export interface SelfUpdaterDeps {
  me(): Promise<Pick<WorkerMeResponse, 'auto_update' | 'update_requested_at'>>;
  latest(): Promise<string | null>;
  startTask(name: string): Promise<void>;
  writeRequest(req: UpdateRequest): void;
  now(): number;
  random(): number;
  /**
   * Trả các việc còn chạy về hub (`fail` retryable) và dừng chúng, trước khi updater dừng worker: hub giao việc cho máy
   * khác ngay thay vì chờ lease hết hạn (prod 22/10: AG-186 tự cập nhật giữa một bản cuối 4K, job hết lease).
   */
  releaseJobs?(reason: string): Promise<void>;
}

export interface SelfUpdaterOptions {
  packageName: string;
  version: string;
  updaterTask: string;
  updaterDir: string;
  checkMs: number;
  drainMs: number;
  /** Chu kỳ hỏi `/v1/worker/me` (mặc định 60 s). */
  meMs?: number;
  /** Lần kiểm đầu sau khi khởi động (mặc định 30 s + ngẫu nhiên tới 90 s). */
  firstCheckMs?: number;
  /** Updater không dừng worker sau chừng này thì coi như không chạy, nhận việc lại (mặc định 15 phút). */
  installTimeoutMs?: number;
  log: Logger;
  deps: SelfUpdaterDeps;
  /** Trạng thái vừa đổi: gửi heartbeat ngay (task updater sẽ dừng worker trong vài giây). */
  onChange?: () => void;
}

export class SelfUpdater {
  private phase: 'idle' | 'draining' | 'installing' = 'idle';
  private status: WorkerUpdateStatus = { state: 'idle' };
  private autoUpdate = true;
  private handledRequestAt = 0;
  private failed: { target: string; at: number } | null = null;
  private target: { version: string; reason: 'auto' | 'requested'; requestedAt: number } | null = null;
  private nextCheckAt: number;
  private nextMeAt: number;
  private deadline = 0;

  constructor(private readonly o: SelfUpdaterOptions) {
    const now = o.deps.now();
    this.nextMeAt = now;
    this.nextCheckAt = now + (o.firstCheckMs ?? 30_000 + Math.floor(o.deps.random() * 90_000));
  }

  /** Đọc kết quả lần cập nhật trước (updater ghi) để báo hub và để không thử lại bản đã hỏng. */
  init(outcome: UpdateOutcome | null): void {
    if (!outcome) return;
    const at = outcome.finished_at ? Date.parse(outcome.finished_at) : NaN;
    const since = Number.isFinite(at) ? new Date(at).toISOString() : undefined;
    const requested = outcome.requested_at ? Date.parse(outcome.requested_at) : NaN;
    if (Number.isFinite(requested)) this.handledRequestAt = requested;
    const target = outcome.target_version;
    if (outcome.state === 'failed' && target && compareVersions(target, this.o.version) > 0) {
      this.failed = { target, at: Number.isFinite(at) ? at : this.o.deps.now() };
      this.status = { state: 'failed', target_version: target, ...msg(outcome.message), ...(since ? { since } : {}) };
    } else if (outcome.state === 'done' && target === this.o.version) {
      const from = outcome.from_version ? ` from ${outcome.from_version}` : '';
      this.status = {
        state: 'idle',
        target_version: target,
        ...msg(outcome.message || `Updated${from} to ${target}`),
        ...(since ? { since } : {}),
      };
    }
  }

  /** Đang chờ việc chạy xong hoặc đã giao cho updater: không nhận việc mới. */
  get pausesClaims(): boolean {
    return this.phase !== 'idle';
  }

  get report(): WorkerUpdateStatus {
    return this.status;
  }

  /** Gọi định kỳ (vài giây một lần) từ vòng worker. */
  async tick(runningJobs: number): Promise<void> {
    const { deps, log } = this.o;
    const now = deps.now();

    if (this.phase === 'draining' && this.target) {
      if (runningJobs > 0 && now < this.deadline) return;
      const target = this.target;
      if (runningJobs > 0) {
        log.warn('Update: drain time is over, handing the running jobs back to the hub', { runningJobs });
        try {
          await deps.releaseJobs?.(`Machine is updating to ${target.version}`);
        } catch (err) {
          log.warn('Update: could not hand every job back; their leases will run out', { err: errText(err) });
        }
      }
      try {
        deps.writeRequest({
          package: this.o.packageName,
          from_version: this.o.version,
          target_version: target.version,
          reason: target.reason,
          requested_at: new Date(target.requestedAt).toISOString(),
        });
        await deps.startTask(this.o.updaterTask);
      } catch (err) {
        // Không thử lại bản này tự động (mỗi lần thử là một lần ngừng nhận việc); "Cập nhật ngay" thử lại.
        this.failed = { target: target.version, at: now };
        this.toIdle({ state: 'failed', target_version: target.version, ...msg(`Could not start the updater: ${errText(err)}`) }, now);
        log.error('Update: could not start the updater', { task: this.o.updaterTask, err: errText(err) });
        return;
      }
      this.phase = 'installing';
      this.deadline = now + (this.o.installTimeoutMs ?? 15 * 60_000);
      this.setStatus({ state: 'installing', target_version: target.version }, now);
      log.info('Update: updater started', { task: this.o.updaterTask, target: target.version });
      return;
    }

    if (this.phase === 'installing') {
      if (now < this.deadline) return;
      // Updater không dừng worker (task bận, bị tắt…): nhận việc lại, lần kiểm sau thử tiếp.
      const target = this.target?.version;
      this.toIdle(
        {
          state: 'failed',
          ...(target ? { target_version: target } : {}),
          ...msg(`The updater did not replace this worker in time (see ${this.o.updaterDir}\\updater.log)`),
        },
        now,
      );
      log.warn('Update: the updater did not stop this worker in time, taking jobs again');
      return;
    }

    let requestedAt = 0;
    if (now >= this.nextMeAt) {
      this.nextMeAt = now + (this.o.meMs ?? 60_000);
      try {
        const me = await deps.me();
        this.autoUpdate = me.auto_update !== false;
        const at = me.update_requested_at ? Date.parse(me.update_requested_at) : NaN;
        if (Number.isFinite(at) && at > this.handledRequestAt) {
          this.handledRequestAt = at;
          if (now - at < UPDATE_REQUEST_TTL_MS) requestedAt = at;
        }
      } catch (err) {
        log.debug('Update: worker/me failed', { err: errText(err) });
      }
    }
    const requested = requestedAt > 0;
    if (!requested && now < this.nextCheckAt) return;
    if (!requested) this.nextCheckAt = now + Math.round(this.o.checkMs * (0.8 + 0.4 * deps.random()));
    if (!requested && !this.autoUpdate) return;

    let latest: string | null;
    try {
      latest = await deps.latest();
    } catch (err) {
      log.warn('Update: could not read latest.json', { err: errText(err) });
      if (requested) this.setStatus({ state: 'failed', ...msg(`Could not read latest.json: ${errText(err)}`) }, now);
      return;
    }
    if (!latest || compareVersions(latest, this.o.version) <= 0) {
      if (requested) this.setStatus({ state: 'idle', target_version: this.o.version, ...msg(`Already on the latest version (${this.o.version})`) }, now);
      return;
    }
    if (!requested && this.failed?.target === latest) return;

    this.phase = 'draining';
    this.target = { version: latest, reason: requested ? 'requested' : 'auto', requestedAt: requested ? requestedAt : now };
    this.deadline = now + this.o.drainMs;
    this.setStatus({ state: 'draining', target_version: latest }, now);
    log.info('Update: new version, waiting for running jobs', { from: this.o.version, to: latest, requested });
  }

  private setStatus(status: WorkerUpdateStatus, now: number): void {
    this.status = { ...status, since: new Date(now).toISOString() };
    this.o.onChange?.();
  }

  private toIdle(status: WorkerUpdateStatus, now: number): void {
    this.phase = 'idle';
    this.target = null;
    this.setStatus(status, now);
  }
}

function msg(text: string | undefined): { message?: string } {
  return text ? { message: text.slice(0, 500) } : {};
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
