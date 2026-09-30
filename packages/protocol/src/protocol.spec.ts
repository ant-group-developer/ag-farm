import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  ClaimRequestSchema,
  extractTicket,
  InputNameSchema,
  meetsRequirements,
  mergeRequirements,
  RelativePathSchema,
  ScanAiPayloadSchema,
  ScanExtractPayloadSchema,
  AssetDescriptionSchema,
  JobControlRequestSchema,
  SCAN_AI_MAX_KEYFRAMES,
  signTicket,
  SignRequestSchema,
  SubmitJobRequestSchema,
  TicketError,
  verifyTicket,
  unwrapApiResponse,
  apiErrorOf,
  type Capabilities,
} from './index';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function ticketInput(overrides: Partial<Parameters<typeof signTicket>[0]> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: randomUUID(),
    job_id: randomUUID(),
    owner: 'ag-go',
    type: 'scan.extract' as const,
    attempt: 1,
    exp: now + 180,
    ...overrides,
  };
}

describe('ticket', () => {
  it('round-trips with PEM keys', () => {
    const input = ticketInput();
    const token = signTicket(input, privatePem);
    const claims = verifyTicket(token, publicPem, { owner: 'ag-go' });
    expect(claims.job_id).toBe(input.job_id);
    expect(claims.sub).toBe(input.sub);
    expect(claims.iss).toBe('ag-farm');
  });

  it('rejects another owner', () => {
    const token = signTicket(ticketInput(), privateKey);
    expect(() => verifyTicket(token, publicKey, { owner: 'studio' })).toThrow(
      expect.objectContaining({ reason: 'wrong_owner' }),
    );
  });

  it('rejects an expired ticket beyond the clock tolerance', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signTicket(ticketInput({ exp: now - 100 }), privateKey);
    expect(() => verifyTicket(token, publicKey, { owner: 'ag-go', now })).toThrow(TicketError);
    expect(() => verifyTicket(token, publicKey, { owner: 'ag-go', now, clockToleranceSeconds: 200 })).not.toThrow();
  });

  it('rejects a tampered payload', () => {
    const token = signTicket(ticketInput(), privateKey);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...ticketInput(), iss: 'ag-farm' })).toString('base64url');
    expect(() => verifyTicket(`${header}.${forged}.${signature}`, publicKey, { owner: 'ag-go' })).toThrow(
      expect.objectContaining({ reason: 'bad_signature' }),
    );
  });

  it('rejects a ticket signed by another key', () => {
    const other = generateKeyPairSync('ed25519');
    const token = signTicket(ticketInput(), other.privateKey);
    expect(() => verifyTicket(token, publicKey, { owner: 'ag-go' })).toThrow(
      expect.objectContaining({ reason: 'bad_signature' }),
    );
  });

  it('extracts the ticket from the Authorization header', () => {
    expect(extractTicket('Ticket abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractTicket('Bearer abc')).toBeNull();
    expect(extractTicket(undefined)).toBeNull();
  });
});

describe('paths', () => {
  it.each(['keyframes/0001-1.jpg', 'extract.json', 'a/b/c.mp4'])('accepts %s', (value) => {
    expect(RelativePathSchema.safeParse(value).success).toBe(true);
  });

  it.each(['/abs.jpg', '../x', 'a/../b', 'a//b', 'a\\b', './a', 'a/.', ''])('rejects %s', (value) => {
    expect(RelativePathSchema.safeParse(value).success).toBe(false);
  });

  it('validates input names', () => {
    expect(InputNameSchema.safeParse('source').success).toBe(true);
    expect(InputNameSchema.safeParse('artifact:keyframes/0001-1.jpg').success).toBe(true);
    expect(InputNameSchema.safeParse('artifact:../secret').success).toBe(false);
    expect(InputNameSchema.safeParse('Source').success).toBe(false);
  });

  it('rejects sign ops with traversal', () => {
    const result = SignRequestSchema.safeParse({
      ops: [{ op: 'put', output: '../other/x.jpg', content_type: 'image/jpeg' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('requirements', () => {
  const gpuBox: Capabilities = {
    os: 'windows',
    cpu_cores: 16,
    ram_mb: 65536,
    gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true, nvdec: true }],
    engines: { ffmpeg: 'ffmpeg version 7.1', ollama_models: ['qwen2.5vl:7b'], python: '3.11.9' },
  };
  const cpuBox: Capabilities = { ...gpuBox, gpus: [], engines: { ffmpeg: 'x', ollama_models: [], python: null } };

  it('matches GPU, VRAM, NVENC, models and python', () => {
    expect(
      meetsRequirements(gpuBox, { gpu: true, min_vram_mb: 8000, nvenc: true, ollama_models: ['qwen2.5vl:7b'], python: true }),
    ).toBe(true);
    expect(meetsRequirements(cpuBox, { gpu: true })).toBe(false);
    expect(meetsRequirements(gpuBox, { min_vram_mb: 16000 })).toBe(false);
    expect(meetsRequirements(gpuBox, { ollama_models: ['qwen3-vl:8b'] })).toBe(false);
    expect(meetsRequirements(gpuBox, { os: 'linux' })).toBe(false);
  });

  it('treats a model without tag as :latest', () => {
    const box = { ...gpuBox, engines: { ...gpuBox.engines, ollama_models: ['qwen2.5vl:latest'] } };
    expect(meetsRequirements(box, { ollama_models: ['qwen2.5vl'] })).toBe(true);
  });

  it('always keeps the base requirements of the job type', () => {
    expect(mergeRequirements('scan.ai', {})).toEqual({ gpu: true });
    expect(mergeRequirements('studio.tts', { min_vram_mb: 6000 })).toEqual({
      gpu: true,
      python: true,
      min_vram_mb: 6000,
    });
  });
});

describe('payloads', () => {
  it('fills scan.extract defaults', () => {
    const payload = ScanExtractPayloadSchema.parse({
      asset: {
        id: randomUUID(),
        kind: 'video',
        mime_type: 'video/mp4',
        size_bytes: 10,
        checksum_sha256: null,
        duration_ms: 60000,
        width: 3840,
        height: 2160,
      },
      extract_version: 'x1',
    });
    expect(payload.params.max_keyframes).toBe(24);
    expect(payload.params.keyframe_dedup_distance).toBe(8);
    expect(payload.params.proxy.height).toBe(720);
  });

  it('caps scan.ai at the keyframe limit and fills its options', () => {
    const base = {
      asset_id: randomUUID(),
      model: 'qwen2.5vl:7b',
      prompt_version: 'p2',
      media: { duration_ms: 60000, has_audio: true, has_speech_hint: null },
    };
    const frame = { input: 'artifact:keyframes/0001.jpg', t_ms: 1000 };
    const ok = ScanAiPayloadSchema.parse({ ...base, keyframes: Array(SCAN_AI_MAX_KEYFRAMES).fill(frame) });
    expect(ok.options.frames_per_note).toBe(4);
    expect(ok.context.asset_name).toBeNull();
    expect(ScanAiPayloadSchema.safeParse({ ...base, keyframes: Array(SCAN_AI_MAX_KEYFRAMES + 1).fill(frame) }).success).toBe(false);
  });

  it('limits the asset summary length in words', () => {
    const description = {
      title_vi: 'Phở bò Hà Nội buổi sáng',
      summary_vi: 'Quán phở đông khách buổi sáng, cận cảnh tô phở bò nóng và người bán chan nước dùng.',
      summary_en: 'A busy pho shop in the morning with close-ups of a hot bowl of beef pho.',
      genre: 'ẩm thực đường phố',
      topics: ['phở'],
      subjects: ['tô phở', 'người bán'],
      places: ['Hà Nội'],
      actions: ['chan nước dùng'],
      keywords_vi: ['phở bò'],
      tags: ['pho'],
      mood: 'nhộn nhịp',
      setting: 'indoor',
      time_of_day: 'day',
      people_count: 'few',
      shot_variety: ['close_up', 'medium'],
      camera_motions: ['handheld'],
      visible_text: '',
      has_watermark: false,
      usable: true,
      usable_reason: '',
      quality: 4,
    };
    expect(AssetDescriptionSchema.safeParse(description).success).toBe(true);
    const tooLong = { ...description, summary_en: Array(91).fill('word').join(' ') };
    expect(AssetDescriptionSchema.safeParse(tooLong).success).toBe(false);
  });

  it('job control takes ids or a group, not both', () => {
    expect(JobControlRequestSchema.safeParse({ group_key: 'batch:1' }).success).toBe(true);
    expect(JobControlRequestSchema.safeParse({ ids: [randomUUID()] }).success).toBe(true);
    expect(JobControlRequestSchema.safeParse({}).success).toBe(false);
    expect(JobControlRequestSchema.safeParse({ ids: [randomUUID()], group_key: 'batch:1' }).success).toBe(false);
  });

  it('applies submit defaults', () => {
    const request = SubmitJobRequestSchema.parse({ type: 'scan.extract', payload: {}, correlation_id: 'a:extract' });
    expect(request.priority).toBe(0);
    expect(request.max_attempts).toBe(3);
    expect(request.requirements).toEqual({});
    expect(request.group_key).toBeNull();
    expect(ClaimRequestSchema.parse({ kinds: ['scan.ai'], free_slots: { cpu: 1, gpu: 1 } }).cached_affinity).toEqual([]);
  });
});

// ---- Envelope helpers ----

describe('unwrapApiResponse', () => {
  const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const TS = '2026-09-30T00:00:00.000Z';

  it('extracts data from a success envelope', () => {
    const envelope = {
      data: { node_id: 'n1', status: 'active' },
      requestId: REQ_ID,
      timestamp: TS,
      success: true,
      error: null,
    };
    const result = unwrapApiResponse(envelope);
    expect(result).toEqual({ node_id: 'n1', status: 'active' });
  });

  it('returns raw body unchanged when it is not an envelope', () => {
    const raw = { node_id: 'n1', status: 'active' };
    expect(unwrapApiResponse(raw)).toBe(raw);
  });

  it('returns null data from an error envelope', () => {
    const envelope = {
      data: null,
      requestId: REQ_ID,
      timestamp: TS,
      success: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    };
    expect(unwrapApiResponse(envelope)).toBeNull();
  });

  it('returns array body unchanged', () => {
    const arr = [1, 2, 3];
    expect(unwrapApiResponse(arr)).toBe(arr);
  });
});

describe('apiErrorOf', () => {
  const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const TS = '2026-09-30T00:00:00.000Z';

  it('reads code+message from new envelope error', () => {
    const envelope = {
      data: null,
      requestId: REQ_ID,
      timestamp: TS,
      success: false,
      error: { code: 'lease_lost', message: 'Lease lost', details: { extra: 1 } },
    };
    const err = apiErrorOf(envelope);
    expect(err.code).toBe('lease_lost');
    expect(err.message).toBe('Lease lost');
    expect(err.details).toEqual({ extra: 1 });
  });

  it('reads code from legacy lease_lost shape', () => {
    const legacy = { error: 'lease_lost', message: 'Reaper took lease' };
    const err = apiErrorOf(legacy);
    expect(err.code).toBe('lease_lost');
    expect(err.message).toBe('Reaper took lease');
  });

  it('reads code from legacy job_cancelled shape', () => {
    const legacy = { error: 'job_cancelled', message: 'Job cancelled' };
    expect(apiErrorOf(legacy).code).toBe('job_cancelled');
  });

  it('reads code from NestJS default error shape', () => {
    const nestErr = { statusCode: 404, message: 'Not Found', error: 'Not Found' };
    const err = apiErrorOf(nestErr);
    expect(err.code).toBe('Not Found');
    expect(err.message).toBe('Not Found');
  });

  it('returns empty object for null or non-object', () => {
    expect(apiErrorOf(null)).toEqual({});
    expect(apiErrorOf('string')).toEqual({});
    expect(apiErrorOf(undefined)).toEqual({});
    expect(apiErrorOf([])).toEqual({});
  });

  it('reads code from generic shape', () => {
    expect(apiErrorOf({ code: 'FORBIDDEN', message: 'No access' }).code).toBe('FORBIDDEN');
  });
});
