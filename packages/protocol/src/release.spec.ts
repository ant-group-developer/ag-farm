import {
  compareVersions,
  HeartbeatRequestSchema,
  ReleaseManifestSchema,
  ReleaseVersionSchema,
  WorkerMeResponseSchema,
} from './index';

describe('compareVersions', () => {
  it.each([
    ['0.9.0', '0.8.1', 1],
    ['0.8.1', '0.9.0', -1],
    ['0.10.0', '0.9.9', 1],
    ['1.0.0', '1.0.0', 0],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0-rc.1', '1.0.0-rc.1.1', -1],
    ['v0.9.0', '0.9.0', 0],
    ['garbage', '0.0.1', -1],
    ['0.0.1', 'garbage', 1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe('release manifest', () => {
  const entry = {
    version: '0.9.0',
    file: 'ag-render-worker-0.9.0.zip',
    sha256: 'a'.repeat(64),
    size_bytes: 123,
    built_at: '2026-10-12T01:33:20.025Z',
  };

  it('reads latest.json as the release script writes it', () => {
    const m = ReleaseManifestSchema.parse({ packages: { 'ag-render-worker': entry } });
    expect(m.packages['ag-render-worker']?.version).toBe('0.9.0');
  });

  it('keeps reading when the hub adds keys', () => {
    const m = ReleaseManifestSchema.parse({ packages: { x: { ...entry, notes: 'new' } }, generated_by: 'hub' });
    expect(m.packages['x']?.file).toBe(entry.file);
  });

  it('refuses a file name that leaves the folder', () => {
    expect(ReleaseManifestSchema.safeParse({ packages: { x: { ...entry, file: '../x.zip' } } }).success).toBe(false);
  });

  it('versions look like semver', () => {
    expect(ReleaseVersionSchema.safeParse('0.9.0-rc.1').success).toBe(true);
    expect(ReleaseVersionSchema.safeParse('0.9').success).toBe(false);
    expect(ReleaseVersionSchema.safeParse('0.9.0; rm').success).toBe(false);
  });
});

describe('self-update fields', () => {
  const heartbeat = {
    agent_version: '0.9.0',
    kinds: ['studio.tts'],
    capabilities: {
      os: 'windows',
      cpu_cores: 8,
      ram_mb: 16000,
      gpus: [],
      engines: { ffmpeg: '7.0', ollama_models: [], python: null },
    },
    free_slots: { cpu: 1, gpu: 0 },
    running_job_ids: [],
  };

  it('a heartbeat without update still passes (workers before self-update)', () => {
    expect(HeartbeatRequestSchema.safeParse(heartbeat).success).toBe(true);
  });

  it('a heartbeat carries the update state', () => {
    const r = HeartbeatRequestSchema.safeParse({
      ...heartbeat,
      update: { state: 'draining', target_version: '0.9.1', since: '2026-10-12T01:00:00.000Z' },
    });
    expect(r.success).toBe(true);
  });

  it('an unknown update state or key is refused', () => {
    expect(HeartbeatRequestSchema.safeParse({ ...heartbeat, update: { state: 'sleeping' } }).success).toBe(false);
    expect(HeartbeatRequestSchema.safeParse({ ...heartbeat, update: { state: 'idle', x: 1 } }).success).toBe(false);
  });

  it('worker/me without the update fields (older hub) still parses', () => {
    const me = {
      node_id: '123e4567-e89b-42d3-a456-426614174000',
      name: 'n',
      status: 'active',
      agent_version: null,
      last_seen_at: null,
      ollama_models: [],
    };
    expect(WorkerMeResponseSchema.safeParse(me).success).toBe(true);
    expect(
      WorkerMeResponseSchema.safeParse({ ...me, auto_update: false, update_requested_at: '2026-10-12T01:00:00.000Z' })
        .success,
    ).toBe(true);
  });
});
