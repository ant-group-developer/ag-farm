/**
 * Vòng lặp worker chính: heartbeat → claim → handler → progress → complete/fail.
 * Tắt nhẹ nhàng: SIGINT/SIGTERM → ngừng claim, chờ job đang chạy xong.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  JOB_TYPE_SPECS,
  HEARTBEAT_INTERVAL_SECONDS,
  PROGRESS_INTERVAL_SECONDS,
} from '@ag-farm/protocol';
import type {
  Capabilities,
  ClaimedJob,
  JobError,
  JobResult,
  JobType,
} from '@ag-farm/protocol';
import { Cache } from './cache';
import type { CapabilitiesOptions } from './capabilities';
import { detectCapabilities } from './capabilities';
import type { WorkerConfig } from './config';
import { isWithinSchedule, resolveToken } from './config';
import { HubClient, LeaseLostError } from './hub-client';
import type { Logger } from './logger';
import { rootLogger } from './logger';
import { SlotAllocator, loadMachineConfig } from './machine';
import type { SlotHandle } from './machine';
import { SignClient } from './sign-client';
import type { UploadOutputOptions } from './transfer';
import { downloadToFile, uploadJson, uploadOutput } from './transfer';

// ---- Lỗi không thể thử lại ----

export class NonRetryableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

// ---- Context truyền vào handler ----

export interface JobContext {
  job: ClaimedJob;
  payload: unknown;
  workDir: string;
  sign: SignClient;
  cache: Cache;
  log: Logger;
  /** AbortSignal: bị hủy khi LeaseLostError, job bị cancel, hoặc shutdown. */
  signal: AbortSignal;
  /**
   * Báo tiến độ. Gửi ngay nếu lần gửi trước đã cách đủ `progressMinGapMs`, không thì gửi giá trị mới nhất
   * khi hết khoảng đó; SDK cũng tự gửi lại mỗi 30 giây để giữ lease.
   */
  progress(percent?: number, stage?: string): void;
  /**
   * Job batch: máy đang có việc interactive (Studio) chạy hoặc chờ slot. Handler nên gọi `yieldToInteractive`
   * ở chỗ dừng được (giữa các bước). Job interactive luôn nhận `false`.
   */
  shouldYield(): boolean;
  /**
   * Nhả slot cho việc interactive tới khi máy rảnh rồi lấy lại slot; lease vẫn được giữ. Không làm gì nếu
   * `shouldYield()` là false. Ném lỗi abort nếu job bị huỷ/mất lease trong lúc chờ.
   */
  yieldToInteractive(): Promise<void>;
  download(inputName: string, dest: string, options?: { useCacheKey?: string | null }): Promise<void>;
  upload(localPath: string, outputPath: string, contentType: string, options?: UploadOutputOptions): Promise<void>;
  uploadJson(outputPath: string, data: unknown): Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export interface RunWorkerOptions {
  config: WorkerConfig;
  version: string;
  handlers: Partial<Record<JobType, JobHandler>>;
  capabilitiesOptions?: CapabilitiesOptions;
  /** Nếu có thì bỏ qua bước detect capabilities. Dùng trong tests. */
  capabilities?: Capabilities;
  /** Override khoảng heartbeat (ms). Dùng trong tests. */
  heartbeatIntervalMs?: number;
  /** Override khoảng auto-progress (ms). Dùng trong tests. */
  progressIntervalMs?: number;
  /** Khoảng tối thiểu giữa hai lần gửi tiến độ do handler báo (ms, mặc định 5 s). */
  progressMinGapMs?: number;
  /** Chu kỳ kiểm máy đã rảnh khi job batch đang nhường slot (ms, mặc định 2 s). */
  yieldPollMs?: number;
  /** Signal để dừng worker từ bên ngoài (không cần SIGTERM). */
  stopSignal?: AbortSignal;
}

// ---- Runner ----

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { config, version, handlers } = options;
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
  const progressMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_SECONDS * 1000;
  const progressMinGapMs = options.progressMinGapMs ?? 5_000;
  const yieldPollMs = options.yieldPollMs ?? 2_000;
  const log = rootLogger.child({ worker: config.name, version });

  const token = resolveToken(config);
  const hub = new HubClient(config.hub_url, token);
  const machineFile = config.machine_file!;
  const machineConfig = loadMachineConfig(machineFile);
  const allocator = new SlotAllocator(machineConfig, machineFile);
  const cache = new Cache(config.cache.dir, config.cache.max_gb);

  // Năng lực
  let capabilities: Capabilities;
  if (options.capabilities) {
    capabilities = options.capabilities;
  } else {
    try {
      capabilities = await detectCapabilities(options.capabilitiesOptions);
      log.info('Capabilities detected', { os: capabilities.os, gpus: capabilities.gpus.length });
    } catch (err) {
      log.error('Failed to detect capabilities', { err: String(err) });
      throw err;
    }
  }

  let running = true;
  let claimEnabled = true;

  const activeJobs = new Map<string, AbortController>();

  // Graceful shutdown
  const shutdown = () => {
    if (!running) return;
    running = false;
    log.info('Shutting down: waiting for running jobs...');
    // Abort all running jobs
    for (const ctrl of activeJobs.values()) ctrl.abort();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  options.stopSignal?.addEventListener('abort', shutdown, { once: true });

  // Heartbeat loop
  const heartbeatLoop = async (): Promise<void> => {
    while (running) {
      try {
        const free = allocator.freeSlots();
        const runningIds = [...activeJobs.keys()];
        const res = await hub.heartbeat({
          agent_version: version,
          kinds: config.kinds,
          capabilities,
          free_slots: free,
          running_job_ids: runningIds,
        });

        if (res.status === 'disabled') {
          claimEnabled = false;
          log.info('Node disabled by hub');
        } else {
          claimEnabled = !config.schedule || isWithinSchedule(config.schedule ?? []);
        }
      } catch (err) {
        log.warn('Heartbeat failed', { err: String(err) });
      }
      await sleep(heartbeatMs);
    }
  };

  void heartbeatLoop();

  // Claim loop
  while (running || activeJobs.size > 0) {
    if (!running) {
      // Waiting for running jobs to finish
      await sleep(200);
      continue;
    }

    // Kiểm lịch chạy
    const withinSchedule = !config.schedule || isWithinSchedule(config.schedule ?? []);
    if (!withinSchedule) claimEnabled = false;

    if (!claimEnabled) {
      await sleep(3_000);
      continue;
    }

    // Thử claim, từng lane với đúng số slot lane đó được lấy: interactive trước (dùng mọi slot trống),
    // rồi batch (không đụng slot giữ cho interactive). Hub chỉ trả job có loại slot còn trống trong
    // `free_slots`, nên job nhận về luôn chiếm được slot. Trước đây batch được xin với cả slot dự trữ
    // của GPU/CPU khác loại: job CPU nhận về không có slot, bị bỏ rơi tới khi lease hết hạn.
    const kinds = config.kinds.filter((k) => handlers[k]);
    if (kinds.length === 0) { await sleep(5_000); continue; }

    let claimed: Awaited<ReturnType<typeof hub.claim>> | null = null;
    let claimFailed = false;
    for (const lane of ['interactive', 'batch'] as const) {
      // Việc Studio trên máy được ưu tiên: đang có job interactive chạy/chờ thì không nhận thêm việc batch.
      if (lane === 'batch' && allocator.interactivePressure()) continue;
      const free = allocator.freeSlotsFor(lane);
      if (free.cpu === 0 && free.gpu === 0) {
        if (lane === 'interactive') allocator.setWanted(false);
        continue;
      }
      try {
        claimed = await hub.claim({ kinds, free_slots: free, lanes: [lane] });
      } catch (err) {
        log.warn('Claim failed', { err: String(err) });
        claimFailed = true;
        break;
      }
      if (lane === 'interactive') {
        // Hub còn job interactive mình làm được nhưng máy hết slot loại đó: báo worker batch nhường slot.
        const waiting = claimed.waiting_interactive;
        allocator.setWanted(!claimed.job && !!waiting && waiting.cpu + waiting.gpu > 0);
      }
      if (claimed.job) break;
    }
    if (claimFailed) { await sleep(3_000); continue; }

    if (!claimed?.job) {
      await sleep(1_000);
      continue;
    }

    const job = claimed.job;
    const handler = handlers[job.type];
    if (!handler) {
      log.warn('No handler for job type', { type: job.type });
      await sleep(1_000);
      continue;
    }

    const spec = JOB_TYPE_SPECS[job.type];
    const slotLane: 'batch' | 'interactive' = job.lane === 'interactive' ? 'interactive' : 'batch';
    // Cờ interactive bật ngay từ lúc nhận job, kể cả khi còn phải chờ slot: worker batch cùng máy thấy
    // cờ thì ngừng nhận việc và nhường slot.
    const interactiveFlag = slotLane === 'interactive' ? allocator.markInteractive(job.id) : null;
    // Một worker khác trên cùng máy có thể vừa lấy slot đó: chờ slot, giữ lease, không bỏ rơi job.
    const slot = allocator.acquire(spec.slot, { lane: slotLane }) ?? (await waitForSlot(job, spec.slot, slotLane));
    if (!slot) {
      if (interactiveFlag) allocator.clearFlag(interactiveFlag);
      continue;
    }

    // Chạy job trong background
    void runJob(job, handler, slot, progressMs, interactiveFlag);
  }

  allocator.setWanted(false);
  log.info('Worker stopped');

  // ---- Chờ slot cho job đã nhận ----

  async function waitForSlot(
    job: ClaimedJob,
    kind: 'cpu' | 'gpu',
    lane: 'batch' | 'interactive',
  ): Promise<SlotHandle | null> {
    const deadline = Date.now() + 90_000;
    let lastProgress = Date.now();
    while (Date.now() < deadline && !options.stopSignal?.aborted) {
      await sleep(1_000);
      const slot = allocator.acquire(kind, { lane });
      if (slot) return slot;
      if (Date.now() - lastProgress >= Math.min(progressMs, 30_000)) {
        lastProgress = Date.now();
        try {
          await hub.progress(job.id, { lease_token: job.lease_token, stage: 'waiting_for_slot' });
        } catch (err) {
          if (err instanceof LeaseLostError) return null;
        }
      }
    }
    log.warn('No slot for claimed job, giving it back', { jobId: job.id, kind, lane });
    try {
      await hub.fail(job.id, {
        lease_token: job.lease_token,
        error: { code: 'no_slot', message: `No free ${kind} slot on this machine`, retryable: true },
      });
    } catch {
      // lease sẽ hết hạn, reaper trả job về hàng đợi
    }
    return null;
  }

  // ---- Job runner ----

  async function runJob(
    job: ClaimedJob,
    handler: JobHandler,
    initialSlot: SlotHandle,
    progressIntervalMs: number,
    interactiveFlag: string | null,
  ): Promise<void> {
    const jobLog = log.child({ jobId: job.id, type: job.type });
    jobLog.info('Job started', { attempt: job.attempt });

    const workDir = join(config.work_dir, job.id);
    mkdirSync(workDir, { recursive: true });

    const abortCtrl = new AbortController();
    activeJobs.set(job.id, abortCtrl);

    // Slot hiện giữ; null trong lúc job batch đang nhường slot cho việc interactive.
    let slot: SlotHandle | null = initialSlot;
    const releaseAll = (): void => {
      if (slot) allocator.release(slot);
      slot = null;
      if (interactiveFlag) allocator.clearFlag(interactiveFlag);
    };

    let currentTicket = job.ticket;
    const signClient = new SignClient(job.sign_url, () => currentTicket);
    const leaseToken = job.lease_token;

    // Tiến độ: luôn gửi giá trị mới nhất. Lần gọi quá gần lần gửi trước được dời tới hết khoảng
    // `progressMinGapMs` (không bỏ đi như trước: handler báo 8% → 48% mà hub vẫn thấy 2%).
    let latest: { percent?: number; stage?: string } = {};
    let lastSentAt = 0;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    const sendProgress = async (): Promise<void> => {
      if (abortCtrl.signal.aborted) return;
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
      lastSentAt = Date.now();
      try {
        const res = await hub.progress(job.id, { lease_token: leaseToken, ...latest });
        currentTicket = res.ticket;
      } catch (err) {
        if (err instanceof LeaseLostError) {
          jobLog.warn('Lease lost while reporting progress', { reason: err.reason });
          abortCtrl.abort();
        } else {
          jobLog.warn('Progress send failed', { err: String(err) });
        }
      }
    };

    const reportProgress = (percent?: number, stage?: string): void => {
      latest = {
        ...(percent !== undefined ? { percent } : latest.percent !== undefined ? { percent: latest.percent } : {}),
        ...(stage !== undefined ? { stage } : latest.stage !== undefined ? { stage: latest.stage } : {}),
      };
      const wait = lastSentAt + progressMinGapMs - Date.now();
      if (wait <= 0) {
        void sendProgress();
      } else if (!trailingTimer) {
        trailingTimer = setTimeout(() => void sendProgress(), wait);
      }
    };

    // Giữ lease: gửi lại giá trị mới nhất theo chu kỳ.
    const progressTimer = setInterval(() => {
      if (!abortCtrl.signal.aborted) void sendProgress();
    }, progressIntervalMs);

    const stopTimers = (): void => {
      clearInterval(progressTimer);
      if (trailingTimer) clearTimeout(trailingTimer);
      trailingTimer = null;
    };

    const shouldYield = (): boolean => job.lane !== 'interactive' && allocator.interactivePressure();

    const yieldToInteractive = async (): Promise<void> => {
      if (!shouldYield() || !slot) return;
      const kind = slot.kind;
      const stageBefore = latest.stage;
      jobLog.info('Yielding slot to interactive work', { kind });
      allocator.release(slot);
      slot = null;
      reportProgress(undefined, 'waiting_for_interactive');
      while (!slot) {
        if (abortCtrl.signal.aborted) throw new Error('Job aborted while yielding');
        await sleep(yieldPollMs);
        if (!allocator.interactivePressure()) slot = allocator.acquire(kind, { lane: 'batch' });
      }
      jobLog.info('Resumed after yielding', { kind });
      reportProgress(undefined, stageBefore ?? 'running');
    };

    // Validate payload
    const spec = JOB_TYPE_SPECS[job.type];
    let validatedPayload: unknown;
    const payloadResult = spec.payload.safeParse(job.payload);
    if (!payloadResult.success) {
      stopTimers();
      activeJobs.delete(job.id);
      releaseAll();
      try {
        await hub.fail(job.id, {
          lease_token: leaseToken,
          error: { code: 'INVALID_PAYLOAD', message: payloadResult.error.message.slice(0, 2000), retryable: false },
        });
      } catch { /* ignore */ }
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    }
    validatedPayload = payloadResult.data;

    const ctx: JobContext = {
      job,
      payload: validatedPayload,
      workDir,
      sign: signClient,
      cache,
      log: jobLog,
      signal: abortCtrl.signal,
      progress: reportProgress,
      shouldYield,
      yieldToInteractive,
      async download(inputName, dest, opts) {
        const { url, cacheKey } = await signClient.getInput(inputName);
        const effectiveKey = opts?.useCacheKey !== undefined ? opts.useCacheKey : cacheKey;
        if (effectiveKey) {
          const cached = await cache.getOrDownload(effectiveKey, null, async (tmpDest) => {
            await downloadToFile(url, tmpDest, { signal: abortCtrl.signal });
          });
          mkdirSync(dirname(dest), { recursive: true });
          copyFileSync(cached, dest);
        } else {
          await downloadToFile(url, dest, { signal: abortCtrl.signal });
        }
      },
      async upload(localPath, outputPath, contentType, uploadOpts) {
        await uploadOutput(signClient, localPath, outputPath, contentType, uploadOpts);
      },
      async uploadJson(outputPath, data) {
        await uploadJson(signClient, outputPath, data);
      },
    };

    try {
      const result = await handler(ctx);

      stopTimers();

      if (!abortCtrl.signal.aborted) {
        await hub.complete(job.id, { lease_token: leaseToken, result });
        jobLog.info('Job completed', { manifest: result.manifest });
      }
    } catch (err) {
      stopTimers();

      if (err instanceof LeaseLostError || abortCtrl.signal.aborted) {
        jobLog.warn('Job aborted', { reason: err instanceof LeaseLostError ? err.reason : 'signal' });
        // Không gọi fail: lease đã mất hoặc job bị cancel
      } else {
        const jobError = errorToJobError(err);
        jobLog.error('Job failed', { code: jobError.code, retryable: jobError.retryable });
        try {
          await hub.fail(job.id, { lease_token: leaseToken, error: jobError });
        } catch (failErr) {
          jobLog.warn('Failed to report failure', { err: String(failErr) });
        }
      }
    }

    activeJobs.delete(job.id);
    releaseAll();
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function errorToJobError(err: unknown): JobError {
  if (err instanceof NonRetryableError) {
    return { code: err.code, message: err.message, retryable: false };
  }
  if (err instanceof Error) {
    return { code: 'WORKER_ERROR', message: err.message.slice(0, 2000), retryable: true };
  }
  return { code: 'UNKNOWN', message: String(err).slice(0, 2000), retryable: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
