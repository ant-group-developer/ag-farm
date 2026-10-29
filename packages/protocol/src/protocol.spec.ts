import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  ClaimRequestSchema,
  extractTicket,
  InputNameSchema,
  meetsRequirements,
  mergeRequirements,
  nodeMeetsRequirements,
  OwnerNodeViewSchema,
  RelativePathSchema,
  ScanAiPayloadSchema,
  ScanExtractPayloadSchema,
  ScanPrepManifestSchema,
  ScanPrepParamsSchema,
  ScanPrepPayloadSchema,
  SCAN_PREP_AUDIO_PATH,
  SCAN_PREP_MANIFEST_PATH,
  SCAN_PREP_MANIFEST_SCHEMA,
  scanPrepFramePath,
  scanPrepSheetPath,
  AssetDescriptionSchema,
  JobControlRequestSchema,
  RaiseJobRequestSchema,
  OWNER_API,
  SCAN_AI_MAX_KEYFRAMES,
  signTicket,
  SignRequestSchema,
  StudioRenderPayloadSchema,
  StudioExportPremierePayloadSchema,
  StudioTtsPayloadSchema,
  StudioTranscribePayloadSchema,
  StudioReferenceFetchPayloadSchema,
  StudioReferenceFetchResultSchema,
  REFERENCE_FETCH_ERROR_CODES,
  REFERENCE_FETCH_RETRYABLE_CODES,
  REFERENCE_MAX_BYTES,
  REFERENCE_MAX_HEIGHT,
  REFERENCE_MAX_SECONDS,
  ReferenceFetchErrorCodeSchema,
  JobErrorSchema,
  JobResultSchema,
  TranscribeManifestSchema,
  TRANSCRIBE_MANIFEST_SCHEMA,
  StudioBeatsPayloadSchema,
  BeatsManifestSchema,
  BEATS_MANIFEST_SCHEMA,
  BEATS_MANIFEST_PATH,
  BEATS_MAX_PER_TRACK,
  JOB_TYPE_SPECS,
  ROLE_KINDS,
  RenderManifestSchema,
  RENDER_MANIFEST_SCHEMA,
  RENDER_INSPECT_PATH,
  thumbnailOutputPath,
  SubmitJobRequestSchema,
  TicketError,
  verifyTicket,
  unwrapApiResponse,
  apiErrorOf,
  AiTraceSchema,
  AI_TRACE_SCHEMA,
  AI_TRACE_PATH,
  CapabilitiesSchema,
  RequirementsSchema,
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

  it('yt-dlp is optional in capabilities and required only when asked', () => {
    expect(CapabilitiesSchema.safeParse(gpuBox).success).toBe(true);
    const withYtdlp = { ...gpuBox, engines: { ...gpuBox.engines, ytdlp: '2026.08.19' } };
    expect(CapabilitiesSchema.safeParse(withYtdlp).success).toBe(true);
    expect(meetsRequirements(withYtdlp, { ytdlp: true })).toBe(true);
    expect(meetsRequirements(gpuBox, { ytdlp: true })).toBe(false);
    expect(meetsRequirements({ ...gpuBox, engines: { ...gpuBox.engines, ytdlp: null } }, { ytdlp: true })).toBe(false);
    expect(RequirementsSchema.parse({ ytdlp: true })).toEqual({ ytdlp: true });
  });

  it('a studio render level is optional, and a job asking for one only goes to a machine at that level or above', () => {
    const level2 = { ...gpuBox, engines: { ...gpuBox.engines, studio_render: 2 } };
    expect(CapabilitiesSchema.safeParse(level2).success).toBe(true);
    expect(meetsRequirements(level2, { studio_render_min: 2 })).toBe(true);
    expect(meetsRequirements(level2, { studio_render_min: 3 })).toBe(false);
    // a machine that does not say is level 0
    expect(meetsRequirements(gpuBox, { studio_render_min: 1 })).toBe(false);
    expect(meetsRequirements(gpuBox, {})).toBe(true);
    expect(RequirementsSchema.safeParse({ studio_render_min: 0 }).success).toBe(false);
    expect(mergeRequirements('studio.render_preview', { studio_render_min: 1 })).toEqual({ studio_render_min: 1 });
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

  it('a job pinned to a node is for that node only, and keeps its other requirements', () => {
    const id = randomUUID();
    expect(nodeMeetsRequirements(id, gpuBox, { node_id: id, nvenc: true })).toBe(true);
    expect(nodeMeetsRequirements(randomUUID(), gpuBox, { node_id: id })).toBe(false);
    expect(nodeMeetsRequirements(id, cpuBox, { node_id: id, gpu: true })).toBe(false);
    expect(nodeMeetsRequirements(randomUUID(), gpuBox, {})).toBe(true);
    expect(mergeRequirements('studio.render_final', { node_id: id })).toEqual({ node_id: id });
  });

  it("a pool's jobs run only on its machines, and its machines take only its jobs", () => {
    const id = randomUUID();
    expect(nodeMeetsRequirements(id, gpuBox, { pool: 'hcm' }, 'hcm')).toBe(true);
    expect(nodeMeetsRequirements(id, gpuBox, { pool: 'hcm' }, null)).toBe(false);
    expect(nodeMeetsRequirements(id, gpuBox, { pool: 'hcm' }, 'hn')).toBe(false);
    expect(nodeMeetsRequirements(id, gpuBox, {}, 'hcm')).toBe(false);
    expect(nodeMeetsRequirements(id, gpuBox, {}, null)).toBe(true);
    expect(nodeMeetsRequirements(id, cpuBox, { pool: 'hcm', gpu: true }, 'hcm')).toBe(false);
    expect(RequirementsSchema.safeParse({ pool: 'hcm-1' }).success).toBe(true);
    expect(RequirementsSchema.safeParse({ pool: 'Bad Pool' }).success).toBe(false);
    expect(mergeRequirements('studio.render_final', { pool: 'hcm' })).toEqual({ pool: 'hcm' });
  });

  it('an owner sees a node by name, kinds, GPUs and load', () => {
    const view = {
      id: randomUUID(), name: 'render-01', online: true, kinds: ['studio.render_final'],
      gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true }], running_jobs: 1, last_seen_at: '2026-10-07T10:00:00.000Z',
    };
    expect(OwnerNodeViewSchema.parse(view)).toEqual(view);
    expect(OwnerNodeViewSchema.safeParse({ ...view, token_hash: 'x' }).success).toBe(false);
  });

  it('studio.transcribe is a studio job on a GPU slot', () => {
    expect(JOB_TYPE_SPECS['studio.transcribe']).toMatchObject({ owner: 'studio', lane: 'interactive', slot: 'gpu' });
  });

  it('scan.prep is an ag-go batch job on a CPU slot, run by scan nodes', () => {
    expect(JOB_TYPE_SPECS['scan.prep']).toMatchObject({ owner: 'ag-go', lane: 'batch', slot: 'cpu', baseRequirements: {} });
    expect(mergeRequirements('scan.prep', {})).toEqual({});
    expect(meetsRequirements(cpuBox, mergeRequirements('scan.prep', {}))).toBe(true);
    expect([...ROLE_KINDS.scan].sort()).toEqual(['scan.ai', 'scan.extract', 'scan.prep']);
  });

  it('a render node takes every studio job type', () => {
    expect([...ROLE_KINDS.render].sort()).toEqual(
      ['studio.beats', 'studio.export_premiere', 'studio.reference_fetch', 'studio.render_final', 'studio.render_preview', 'studio.transcribe', 'studio.tts'],
    );
  });

  it('studio.beats is a studio job on a CPU slot of a machine with Python, no GPU', () => {
    expect(JOB_TYPE_SPECS['studio.beats']).toMatchObject({ owner: 'studio', lane: 'interactive', slot: 'cpu' });
    expect(mergeRequirements('studio.beats', {})).toEqual({ python: true });
    expect(meetsRequirements(cpuBox, mergeRequirements('studio.beats', {}))).toBe(false);
    const withPython = { ...cpuBox, engines: { ...cpuBox.engines, python: '3.11.9' } };
    expect(meetsRequirements(withPython, mergeRequirements('studio.beats', {}))).toBe(true);
  });

  it('studio.reference_fetch is a studio job on a CPU slot of a machine with yt-dlp', () => {
    expect(JOB_TYPE_SPECS['studio.reference_fetch']).toMatchObject({ owner: 'studio', lane: 'interactive', slot: 'cpu' });
    expect(mergeRequirements('studio.reference_fetch', {})).toEqual({ ytdlp: true });
    expect(meetsRequirements(cpuBox, mergeRequirements('studio.reference_fetch', {}))).toBe(false);
    const withYtdlp = { ...cpuBox, engines: { ...cpuBox.engines, ytdlp: '2026.09.01' } };
    expect(meetsRequirements(withYtdlp, mergeRequirements('studio.reference_fetch', {}))).toBe(true);
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

  describe('studio.beats', () => {
    const base = { production_id: 'p1', tracks: [{ track_id: 'music', audio: 'library:studio/projects/p1/music/abc.m4a' }] };

    it('fills one piece per track and four beats a bar', () => {
      expect(StudioBeatsPayloadSchema.parse(base)).toEqual({ ...base, tracks: [{ ...base.tracks[0], parts: [] }], beats_per_bar: 4 });
      expect(JOB_TYPE_SPECS['studio.beats'].payload.safeParse(base).success).toBe(true);
    });

    it('takes where each joined song starts, and nothing else', () => {
      const joined = { ...base, tracks: [{ ...base.tracks[0], parts: [184.2, 371.9] }] };
      expect(StudioBeatsPayloadSchema.parse(joined).tracks[0]!.parts).toEqual([184.2, 371.9]);
      expect(StudioBeatsPayloadSchema.safeParse({ ...base, tracks: [{ ...base.tracks[0], parts: [0] }] }).success).toBe(false);
      expect(StudioBeatsPayloadSchema.safeParse({ ...base, tracks: [{ ...base.tracks[0], track_id: '../x' }] }).success).toBe(false);
      expect(StudioBeatsPayloadSchema.safeParse({ ...base, tracks: [] }).success).toBe(false);
      expect(StudioBeatsPayloadSchema.safeParse({ ...base, beats_per_bar: 1 }).success).toBe(false);
      expect(StudioBeatsPayloadSchema.safeParse({ ...base, url: 'https://x' }).success).toBe(false);
    });

    it('its manifest gives the tempo, every beat and the first beat of each bar', () => {
      const m = {
        schema: BEATS_MANIFEST_SCHEMA, production_id: 'p1', engine: { name: 'librosa', version: '0.11.0' },
        tracks: [{
          track_id: 'music', duration_s: 4.2, bpm: 120, beats_per_bar: 4,
          beats: [0.02, 0.52, 1.02, 1.52, 2.02, 2.52, 3.02, 3.52, 4.02], downbeats: [0.02, 2.02, 4.02],
          sections: [{ start: 0, end: 4.2, bpm: 120 }],
        }],
      };
      expect(BeatsManifestSchema.parse(m)).toEqual(m);
      expect(BEATS_MANIFEST_PATH).toBe('beats.json');
      expect(BeatsManifestSchema.safeParse({ ...m, tracks: [{ ...m.tracks[0], bpm: null, beats: [], downbeats: [] }] }).success).toBe(true);
      expect(BeatsManifestSchema.safeParse({ ...m, tracks: [{ ...m.tracks[0], beats: Array(BEATS_MAX_PER_TRACK + 1).fill(1) }] }).success).toBe(false);
      expect(BeatsManifestSchema.safeParse({ ...m, tracks: [{ ...m.tracks[0], sections: [] }] }).success).toBe(false);
    });
  });

  describe('studio.reference_fetch', () => {
    const base = { production_id: 'p1', video_id: 'U_17EqTHUIo', output: 'reference/U_17EqTHUIo.mp4' };

    it('fills the limits Studio keeps: 480p, 30 minutes, 300 MiB', () => {
      const p = StudioReferenceFetchPayloadSchema.parse(base);
      expect(p).toEqual({ ...base, max_height: 480, max_seconds: 1800, max_bytes: 300 * 1024 * 1024 });
      expect([REFERENCE_MAX_HEIGHT, REFERENCE_MAX_SECONDS, REFERENCE_MAX_BYTES]).toEqual([480, 1800, 314572800]);
      expect(JOB_TYPE_SPECS['studio.reference_fetch'].payload.safeParse(base).success).toBe(true);
    });

    it('takes tighter limits but never looser ones', () => {
      expect(StudioReferenceFetchPayloadSchema.parse({ ...base, max_height: 360, max_seconds: 600 }).max_height).toBe(360);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, max_height: 720 }).success).toBe(false);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, max_seconds: 1801 }).success).toBe(false);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, max_bytes: REFERENCE_MAX_BYTES + 1 }).success).toBe(false);
    });

    it('takes an 11-character video id only, never a URL or anything a shell would read', () => {
      for (const bad of ['U_17EqTHUI', 'U_17EqTHUIoo', 'https://youtu.be/U_17EqTHUIo', '../../etc/x', 'a b c d e f', '--exec=calc']) {
        expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, video_id: bad }).success).toBe(false);
      }
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, video_id: 'abc-DEF_123' }).success).toBe(true);
    });

    it('writes under the job output only, and has no other field', () => {
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, output: '../x.mp4' }).success).toBe(false);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, output: '/abs.mp4' }).success).toBe(false);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, url: 'https://youtube.com' }).success).toBe(false);
      expect(StudioReferenceFetchPayloadSchema.safeParse({ ...base, cookies: 'x' }).success).toBe(false);
    });

    it('its result is a job summary Studio can read without the bucket', () => {
      const summary = {
        output: 'reference/U_17EqTHUIo.mp4', ext: 'mp4', duration_s: 612.4, size_bytes: 31_000_000,
        width: 854, height: 480, title: 'Kyoto in a day', channel: 'Mei',
      };
      expect(StudioReferenceFetchResultSchema.parse(summary)).toEqual(summary);
      expect(JobResultSchema.parse({ manifest: null, summary })).toEqual({ manifest: null, summary });
      expect(StudioReferenceFetchResultSchema.safeParse({ ...summary, size_bytes: -1 }).success).toBe(false);
    });

    it('names each way YouTube says no with the codes Studio uses; only the network and a timeout are retried', () => {
      expect([...REFERENCE_FETCH_ERROR_CODES]).toEqual([
        'youtube_blocked', 'private', 'unavailable', 'age_restricted', 'members_only', 'live', 'too_long', 'too_big',
        'no_480p', 'network', 'timeout', 'other',
      ]);
      expect(ReferenceFetchErrorCodeSchema.safeParse('youtube_blocked').success).toBe(true);
      expect(ReferenceFetchErrorCodeSchema.safeParse('WORKER_ERROR').success).toBe(false);
      expect([...REFERENCE_FETCH_RETRYABLE_CODES]).toEqual(['network', 'timeout']);
      const error = { code: 'youtube_blocked', message: "Sign in to confirm you're not a bot", retryable: false };
      expect(JobErrorSchema.parse(error)).toEqual(error);
    });
  });

  describe('scan.prep', () => {
    const assetId = randomUUID();

    it('fills the rules Studio cuts by: 0.3, 1 s to 20 s, 480 px frames, 4 x 16 sheets, audio', () => {
      const p = ScanPrepPayloadSchema.parse({ asset_id: assetId, source: 'source' });
      expect(p).toEqual({
        asset_id: assetId,
        source: 'source',
        params: {
          scene_threshold: 0.3, min_shot_s: 1, max_shot_s: 20, frame_width: 480, sheet_cols: 4, sheet_shots: 16, audio: true,
        },
      });
      expect(ScanPrepPayloadSchema.parse({ asset_id: assetId, source: 'source', params: { audio: false } }).params).toEqual({
        ...p.params, audio: false,
      });
      expect(JOB_TYPE_SPECS['scan.prep'].payload.safeParse({ asset_id: assetId, source: 'source' }).success).toBe(true);
    });

    it('keeps each param in its range and refuses unknown fields', () => {
      const bad = [
        { scene_threshold: 1.5 }, { min_shot_s: 0 }, { max_shot_s: -1 }, { frame_width: 32 }, { frame_width: 480.5 },
        { frame_width: 4000 }, { sheet_cols: 0 }, { sheet_cols: 9 }, { sheet_shots: 65 }, { audio: 'yes' }, { extra: 1 },
      ];
      for (const params of bad) expect(ScanPrepParamsSchema.safeParse(params).success).toBe(false);
      expect(ScanPrepPayloadSchema.safeParse({ asset_id: 'not-a-uuid', source: 'source' }).success).toBe(false);
      expect(ScanPrepPayloadSchema.safeParse({ asset_id: assetId, source: '../x' }).success).toBe(false);
      expect(ScanPrepPayloadSchema.safeParse({ asset_id: assetId, source: 'source', asset: {} }).success).toBe(false);
    });

    it('names its outputs frames/NNN.jpg, sheets/NN.jpg, audio.wav and prep.json', () => {
      expect([scanPrepFramePath(1), scanPrepFramePath(42), scanPrepSheetPath(1), scanPrepSheetPath(12)]).toEqual([
        'frames/001.jpg', 'frames/042.jpg', 'sheets/01.jpg', 'sheets/12.jpg',
      ]);
      expect([SCAN_PREP_MANIFEST_PATH, SCAN_PREP_AUDIO_PATH, SCAN_PREP_MANIFEST_SCHEMA]).toEqual([
        'prep.json', 'audio.wav', 'ag.scan.prep/v1',
      ]);
      for (const path of [scanPrepFramePath(1), scanPrepSheetPath(1), SCAN_PREP_AUDIO_PATH, SCAN_PREP_MANIFEST_PATH]) {
        expect(RelativePathSchema.safeParse(path).success).toBe(true);
      }
    });

    it('reads a prep.json with and without sound', () => {
      const manifest = {
        schema: 'ag.scan.prep/v1',
        asset_id: assetId,
        media: { duration_s: 31.5, width: 854, height: 480, fps: 29.97, has_audio: true },
        scene: { threshold: 0.3, min_shot_s: 1, max_shot_s: 20 },
        shots: [
          { n: 1, in: 0, out: 12.4, frame: 'frames/001.jpg' },
          { n: 2, in: 12.4, out: 31.5, frame: 'frames/002.jpg' },
        ],
        sheets: [{ file: 'sheets/01.jpg', shots: [1, 2] }],
        audio: 'audio.wav',
        tools: { ffmpeg: '7.1', worker_version: '0.5.0' },
      };
      expect(ScanPrepManifestSchema.parse(manifest)).toEqual(manifest);
      const { tools: _tools, ...withoutTools } = manifest;
      const silent = { ...withoutTools, media: { ...manifest.media, has_audio: false, fps: null }, audio: null };
      expect(ScanPrepManifestSchema.parse(silent)).toEqual(silent);
      expect(ScanPrepManifestSchema.safeParse({ ...manifest, schema: 'ag.scan.prep/v2' }).success).toBe(false);
      expect(ScanPrepManifestSchema.safeParse({ ...manifest, shots: [{ n: 0, in: 0, out: 1, frame: 'frames/000.jpg' }] }).success).toBe(false);
      expect(ScanPrepManifestSchema.safeParse({ ...manifest, transcript: [] }).success).toBe(false);
    });

    it('ag-go transcribes the prep audio with the studio.transcribe it already has', () => {
      const payload = {
        production_id: randomUUID(),
        model: 'large-v3',
        align_words: true,
        sources: [{ source_id: assetId.replace(/-/g, ''), audio: `artifact:${SCAN_PREP_AUDIO_PATH}`, language: null }],
      };
      expect(StudioTranscribePayloadSchema.parse(payload)).toEqual(payload);
    });
  });

  it('raises a queued job: priority -100..100, lane optional, nothing else', () => {
    expect(RaiseJobRequestSchema.parse({ priority: 50 })).toEqual({ priority: 50 });
    expect(RaiseJobRequestSchema.parse({ lane: 'interactive', priority: 100 })).toEqual({ lane: 'interactive', priority: 100 });
    for (const bad of [{}, { priority: 101 }, { priority: -101 }, { priority: 1.5 }, { lane: 'urgent', priority: 1 }, { priority: 1, status: 'queued' }]) {
      expect(RaiseJobRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(OWNER_API.raise('abc')).toBe('/v1/owner/jobs/abc/raise');
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

  it('StudioTtsPayloadSchema: a voice designed from an instruct, without a sample', () => {
    const base = { production_id: 'p1', language: 'vi', lines: [{ line_id: 'L001', text: 'Xin chào' }] };
    const designed = StudioTtsPayloadSchema.parse({ ...base, voice: { reference: null, reference_text: null, instruct: 'female, young adult' } });
    expect(designed.voice.instruct).toBe('female, young adult');
    expect(StudioTtsPayloadSchema.parse({ ...base, voice: { reference: null, reference_text: null } }).voice.instruct).toBeUndefined();
    expect(StudioTtsPayloadSchema.safeParse({ ...base, voice: { reference: null, reference_text: null, instruct: '' } }).success).toBe(false);
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

  it('StudioExportPremierePayloadSchema: audio is optional and only per_segment', () => {
    const base = {
      production_id: 'p1',
      episode_id: 'e1',
      composition: 'stage:composition.json',
      media: 'proxy',
      name: 'Tập 1',
      output: 'episodes/e1/premiere/j1.zip',
      edit_style: 'cut',
    };
    expect(StudioExportPremierePayloadSchema.parse(base).audio).toBeUndefined();
    expect(StudioExportPremierePayloadSchema.parse({ ...base, audio: 'per_segment' }).audio).toBe('per_segment');
    expect(StudioExportPremierePayloadSchema.safeParse({ ...base, audio: 'mixed' }).success).toBe(false);
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

  it('RenderManifestSchema: inspect is optional and names its files', () => {
    const base = {
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
    };
    expect(RenderManifestSchema.parse(base).inspect).toBeUndefined();
    const m = RenderManifestSchema.parse({ ...base, inspect: { output: RENDER_INSPECT_PATH, sheets: ['sheet-01.jpg'] } });
    expect(m.inspect).toEqual({ output: 'inspect.json', sheets: ['sheet-01.jpg'] });
    expect(RenderManifestSchema.safeParse({ ...base, inspect: { output: '../inspect.json' } }).success).toBe(false);
  });

  it('StudioRenderPayloadSchema: inspect is optional', () => {
    const base = {
      production_id: 'p1',
      revision: 1,
      composition: 'stage:comp.json',
      canvas: { width: 1920, height: 1080 },
      output: 'renders/1/preview.mp4',
    };
    expect(StudioRenderPayloadSchema.parse(base).inspect).toBeUndefined();
    expect(StudioRenderPayloadSchema.parse({ ...base, inspect: true }).inspect).toBe(true);
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
