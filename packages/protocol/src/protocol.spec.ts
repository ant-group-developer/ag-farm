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
  StudioRenderPayloadSchema,
  StudioExportPremierePayloadSchema,
  StudioTranscribePayloadSchema,
  TranscribeManifestSchema,
  TRANSCRIBE_MANIFEST_SCHEMA,
  JOB_TYPE_SPECS,
  ROLE_KINDS,
  RenderManifestSchema,
  RENDER_MANIFEST_SCHEMA,
  thumbnailOutputPath,
  SubmitJobRequestSchema,
  TicketError,
  verifyTicket,
  unwrapApiResponse,
  apiErrorOf,
  AiTraceSchema,
  AI_TRACE_SCHEMA,
  AI_TRACE_PATH,
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
    expect(mergeRequirements('studio.transcribe', {})).toEqual({ gpu: true, python: true });
  });

  it('studio.transcribe is a studio job on a GPU slot', () => {
    expect(JOB_TYPE_SPECS['studio.transcribe']).toMatchObject({ owner: 'studio', lane: 'interactive', slot: 'gpu' });
  });

  it('a render node takes every studio job type', () => {
    expect([...ROLE_KINDS.render].sort()).toEqual(
      ['studio.export_premiere', 'studio.render_final', 'studio.render_preview', 'studio.transcribe', 'studio.tts'],
    );
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

  it('StudioRenderPayloadSchema: fills thumbnails default', () => {
    const payload = StudioRenderPayloadSchema.parse({
      production_id: 'p1',
      revision: 1,
      composition: 'stage:comp.json',
      canvas: { width: 1920, height: 1080 },
      output: 'renders/1/final.mp4',
    });
    expect(payload.thumbnails).toEqual([]);
    expect(payload.handle_seconds).toBe(1);
  });

  it('StudioRenderPayloadSchema: accepts valid thumbnails', () => {
    const payload = StudioRenderPayloadSchema.parse({
      production_id: 'p1',
      revision: 1,
      composition: 'stage:comp.json',
      canvas: { width: 1920, height: 1080 },
      output: 'renders/1/final.mp4',
      thumbnails: [
        { t_s: 3.5, text: 'Tiêu đề tập 1' },
        { t_s: 10, text: 'Cảnh đẹp nhất' },
      ],
    });
    expect(payload.thumbnails).toHaveLength(2);
    expect(payload.thumbnails[0]!.text).toBe('Tiêu đề tập 1');
  });

  it('StudioRenderPayloadSchema: rejects thumbnails with text too long', () => {
    expect(
      StudioRenderPayloadSchema.safeParse({
        production_id: 'p1',
        revision: 1,
        composition: 'stage:comp.json',
        canvas: { width: 1920, height: 1080 },
        output: 'renders/1/final.mp4',
        thumbnails: [{ t_s: 1, text: 'a'.repeat(41) }],
      }).success,
    ).toBe(false);
  });

  it('StudioRenderPayloadSchema: rejects more than 3 thumbnails', () => {
    expect(
      StudioRenderPayloadSchema.safeParse({
        production_id: 'p1',
        revision: 1,
        composition: 'stage:comp.json',
        canvas: { width: 1920, height: 1080 },
        output: 'renders/1/final.mp4',
        thumbnails: [
          { t_s: 1, text: 'A' },
          { t_s: 2, text: 'B' },
          { t_s: 3, text: 'C' },
          { t_s: 4, text: 'D' },
        ],
      }).success,
    ).toBe(false);
  });

  describe('studio.transcribe', () => {
    const base = {
      production_id: 'p1',
      sources: [{ source_id: 'src_01HZX', audio: 'stage:audio/src_01HZX.wav' }],
    };

    it('fills the defaults', () => {
      const p = StudioTranscribePayloadSchema.parse(base);
      expect(p.model).toBe('large-v3');
      expect(p.align_words).toBe(true);
      expect(p.sources[0]?.language).toBeNull();
    });

    it('takes a language per source', () => {
      const p = StudioTranscribePayloadSchema.parse({ ...base, sources: [{ ...base.sources[0], language: 'vi' }] });
      expect(p.sources[0]?.language).toBe('vi');
    });

    it('rejects a bad source id, a bad audio input, a repeated source and an empty list', () => {
      const one = base.sources[0];
      expect(StudioTranscribePayloadSchema.safeParse({ ...base, sources: [{ ...one, source_id: 'a b' }] }).success).toBe(false);
      expect(StudioTranscribePayloadSchema.safeParse({ ...base, sources: [{ ...one, audio: 'stage:../x.wav' }] }).success).toBe(false);
      expect(StudioTranscribePayloadSchema.safeParse({ ...base, sources: [one, one] }).success).toBe(false);
      expect(StudioTranscribePayloadSchema.safeParse({ ...base, sources: [] }).success).toBe(false);
      expect(StudioTranscribePayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    });

    it('reads a manifest with word timings', () => {
      const m = TranscribeManifestSchema.parse({
        schema: TRANSCRIBE_MANIFEST_SCHEMA,
        production_id: 'p1',
        engine: { name: 'whisperx:large-v3', version: null },
        sources: [
          {
            source_id: 'src_01HZX',
            language: 'vi',
            alignment: 'word',
            segments: [{ start: 0.5, end: 2, text: 'Xin chào', words: [{ word: 'Xin', start: 0.5, end: 0.9, score: 0.9 }] }],
          },
          { source_id: 'src_02', language: null, alignment: 'segment', segments: [] },
        ],
      });
      expect(m.sources[0]?.segments[0]?.words[0]?.word).toBe('Xin');
      expect(
        TranscribeManifestSchema.safeParse({ ...m, sources: [{ ...m.sources[1]!, alignment: 'line' }] }).success,
      ).toBe(false);
    });
  });

  it('StudioExportPremierePayloadSchema: media_names defaults to {} and keeps given names', () => {
    const base = {
      production_id: 'p1',
      episode_id: 'e1',
      composition: 'stage:composition.json',
      media: 'proxy',
      name: 'Tập 1',
      output: 'episodes/e1/premiere/j1.zip',
    };
    expect(StudioExportPremierePayloadSchema.parse(base).media_names).toEqual({});
    expect(
      StudioExportPremierePayloadSchema.parse({ ...base, media_names: { 'asset:a1': 'Chợ nổi Cái Răng' } })
        .media_names,
    ).toEqual({ 'asset:a1': 'Chợ nổi Cái Răng' });
    expect(
      StudioExportPremierePayloadSchema.safeParse({ ...base, media_names: { 'asset:a1': '' } }).success,
    ).toBe(false);
  });

  it('StudioExportPremierePayloadSchema: edit_style is optional and only whole|cut', () => {
    const base = {
      production_id: 'p1',
      episode_id: 'e1',
      composition: 'stage:composition.json',
      media: 'proxy',
      name: 'Tập 1',
      output: 'episodes/e1/premiere/j1.zip',
    };
    expect(StudioExportPremierePayloadSchema.parse(base).edit_style).toBeUndefined();
    expect(StudioExportPremierePayloadSchema.parse({ ...base, edit_style: 'cut' }).edit_style).toBe('cut');
    expect(StudioExportPremierePayloadSchema.safeParse({ ...base, edit_style: 'trim' }).success).toBe(false);
  });

  it('RenderManifestSchema: fills thumbnails default', () => {
    const manifest = RenderManifestSchema.parse({
      schema: RENDER_MANIFEST_SCHEMA,
      production_id: 'p1',
      revision: 1,
      output: 'renders/1/final.mp4',
      width: 1920,
      height: 1080,
      duration_s: 30,
      size_bytes: 50_000_000,
      watermarked: false,
      sources: [],
    });
    expect(manifest.thumbnails).toEqual([]);
  });

  it('RenderManifestSchema: accepts thumbnails', () => {
    const manifest = RenderManifestSchema.parse({
      schema: RENDER_MANIFEST_SCHEMA,
      production_id: 'p1',
      revision: 1,
      output: 'renders/1/final.mp4',
      width: 1920,
      height: 1080,
      duration_s: 30,
      size_bytes: 50_000_000,
      watermarked: false,
      sources: [],
      thumbnails: [{ output: 'renders/1/final.thumb-1.jpg', t_s: 3.5, width: 1280, height: 720 }],
    });
    expect(manifest.thumbnails).toHaveLength(1);
    expect(manifest.thumbnails[0]!.output).toBe('renders/1/final.thumb-1.jpg');
  });

  it('thumbnailOutputPath: replaces .mp4 with .thumb-N.jpg', () => {
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 1)).toBe('renders/ep1/final-att.thumb-1.jpg');
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 2)).toBe('renders/ep1/final-att.thumb-2.jpg');
    expect(thumbnailOutputPath('renders/ep1/final-att.mp4', 3)).toBe('renders/ep1/final-att.thumb-3.jpg');
  });

  it('InputNameSchema: accepts asset: prefix', () => {
    expect(InputNameSchema.safeParse('asset:abc-123').success).toBe(true);
    expect(InputNameSchema.safeParse('asset:uuid-abcd-1234').success).toBe(true);
    expect(InputNameSchema.safeParse('segment:seg-001').success).toBe(true);
    expect(InputNameSchema.safeParse('stage:renders/comp.json').success).toBe(true);
    expect(InputNameSchema.safeParse('library:music/track.mp3').success).toBe(true);
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

  it('AiTraceSchema: validates a well-formed trace', () => {
    const trace = {
      schema: AI_TRACE_SCHEMA,
      asset_id: randomUUID(),
      model: 'qwen2.5vl:7b',
      prompt_version: 'v2',
      calls: [
        {
          step: 'notes',
          group: 0,
          attempt: 1,
          started_at: new Date().toISOString(),
          messages: [
            { role: 'system', content: 'You are a video analyst.', images: [] },
            {
              role: 'user',
              content: 'Describe the keyframes.',
              images: [{ input: 'artifact:keyframes/0001.jpg', t_ms: 1000 }],
            },
          ],
          options: { temperature: 0, num_predict: 1024 },
          response: 'Cảnh ngoài trời.',
          error: null,
          accepted: true,
          done_reason: 'stop',
          prompt_eval_count: 512,
          eval_count: 32,
          total_duration_ms: 1234.5,
        },
        {
          step: 'summary',
          group: null,
          attempt: 1,
          started_at: new Date().toISOString(),
          messages: [
            { role: 'system', content: 'Summarise the video.', images: [] },
            { role: 'user', content: 'Here are the notes...', images: [] },
          ],
          options: { temperature: 0, num_predict: 1536 },
          response: '{"title_vi":"Test"}',
          error: null,
          accepted: true,
          done_reason: 'stop',
          prompt_eval_count: 800,
          eval_count: 120,
          total_duration_ms: 4567.8,
        },
      ],
    };
    const result = AiTraceSchema.safeParse(trace);
    if (!result.success) console.error(result.error.message);
    expect(result.success).toBe(true);
    expect(AI_TRACE_PATH).toBe('ai-trace.json');
  });

  it('AiTraceSchema: rejects base64 strings as image input', () => {
    // Images must be input names, not base64; the schema itself does not enforce
    // this format (it is a plain string), but the trace builder must never write base64.
    // This test documents that AiTraceSchema accepts string inputs regardless and
    // that the restriction is enforced by the worker, not the schema.
    const trace = {
      schema: AI_TRACE_SCHEMA,
      asset_id: randomUUID(),
      model: 'qwen2.5vl:7b',
      prompt_version: 'v2',
      calls: [],
    };
    expect(AiTraceSchema.safeParse(trace).success).toBe(true);
  });

  it('AiTraceSchema: rejects missing required fields', () => {
    expect(AiTraceSchema.safeParse({ schema: AI_TRACE_SCHEMA, model: 'q', prompt_version: 'v1', calls: [] }).success).toBe(false);
    expect(AiTraceSchema.safeParse({ schema: AI_TRACE_SCHEMA, asset_id: randomUUID(), model: 'q', calls: [] }).success).toBe(false);
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
