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
  /** Báo tiến độ (throttled; SDK cũng tự gửi mỗi 30 giây để giữ lease). */
  progress(percent: number, stage?: string): void;
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
  /** Signal để dừng worker từ bên ngoài (không cần SIGTERM). */
  stopSignal?: AbortSignal;
}

// ---- Runner ----

export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const { config, version, handlers } = options;
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
  const progressMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_SECONDS * 1000;
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

    // Thử claim
    const free = allocator.freeSlots();
    const kinds = config.kinds.filter((k) => handlers[k]);
    if (kinds.length === 0) { await sleep(5_000); continue; }

    // Lane logic: batch chỉ được dùng non-reserved slots
    const lanes: Array<'interactive' | 'batch'> = [];
    const cpuFreeForBatch = free.cpu - machineConfig.reserve_interactive.cpu;
    const gpuFreeForBatch = free.gpu - machineConfig.reserve_interactive.gpu;
    if (cpuFreeForBatch > 0 || gpuFreeForBatch > 0) {
      // Không giới hạn lane
    } else if (free.cpu > 0 || free.gpu > 0) {
      lanes.push('interactive');
    }

    // Nếu không còn slot nào
    if (free.cpu === 0 && free.gpu === 0) {
      await sleep(1_000);
      continue;
    }

    let claimed;
    try {
      claimed = await hub.claim({
        kinds,
        free_slots: free,
        lanes: lanes.length > 0 ? lanes : undefined,
      });
    } catch (err) {
      log.warn('Claim failed', { err: String(err) });
      await sleep(3_000);
      continue;
    }

    if (!claimed.job) {
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
    const slot = allocator.acquire(spec.slot, { lane: slotLane });
    if (!slot) {
      await sleep(500);
      continue;
    }

    // Chạy job trong background
    void runJob(job, handler, slot, progressMs);
  }

  log.info('Worker stopped');

  // ---- Job runner ----

  async function runJob(
    job: ClaimedJob,
    handler: JobHandler,
    slot: SlotHandle,
    progressIntervalMs: number,
  ): Promise<void> {
    const jobLog = log.child({ jobId: job.id, type: job.type });
    jobLog.info('Job started', { attempt: job.attempt });

    const workDir = join(config.work_dir, job.id);
    mkdirSync(workDir, { recursive: true });

    const abortCtrl = new AbortController();
    activeJobs.set(job.id, abortCtrl);

    let currentTicket = job.ticket;
    const signClient = new SignClient(job.sign_url, () => currentTicket);
    const leaseToken = job.lease_token;

    // Gửi progress lần đầu luôn được (throttle sau đó)
    let lastProgressSent = 0;

    const doProgress = async (percent?: number, stage?: string): Promise<void> => {
      const now = Date.now();
      if (now - lastProgressSent < progressIntervalMs) return;
      lastProgressSent = now;
      try {
        const res = await hub.progress(job.id, { lease_token: leaseToken, percent, stage });
        currentTicket = res.ticket;
      } catch (err) {
        if (err instanceof LeaseLostError) {
          abortCtrl.abort();
          throw err;
        }
        jobLog.warn('Progress send failed', { err: String(err) });
      }
    };

    // Auto progress timer
    const progressTimer = setInterval(() => {
      if (abortCtrl.signal.aborted) return;
      void (async () => {
        try {
          const res = await hub.progress(job.id, { lease_token: leaseToken });
          currentTicket = res.ticket;
          lastProgressSent = Date.now();
        } catch (err) {
          if (err instanceof LeaseLostError) {
            abortCtrl.abort();
          } else {
            jobLog.warn('Auto-progress failed', { err: String(err) });
          }
        }
      })();
    }, progressIntervalMs);

    // Validate payload
    const spec = JOB_TYPE_SPECS[job.type];
    let validatedPayload: unknown;
    const payloadResult = spec.payload.safeParse(job.payload);
    if (!payloadResult.success) {
      clearInterval(progressTimer);
      activeJobs.delete(job.id);
      allocator.release(slot);
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
      progress: (percent, stage) => { void doProgress(percent, stage); },
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

      clearInterval(progressTimer);

      if (!abortCtrl.signal.aborted) {
        await hub.complete(job.id, { lease_token: leaseToken, result });
        jobLog.info('Job completed', { manifest: result.manifest });
      }
    } catch (err) {
      clearInterval(progressTimer);

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
    allocator.release(slot);
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
