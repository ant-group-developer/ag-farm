import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import type { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { toNodeView, toOwnerView } from './admin.views';

const at = new Date('2026-09-30T03:00:00.000Z');

describe('admin views', () => {
  it('trả node dạng snake_case, không kèm hash token', () => {
    const node = {
      id: 'n1',
      name: 'local-render',
      machine: 'PC',
      kinds: ['studio.tts'],
      tokenHash: 'a'.repeat(64),
      status: 'active',
      os: 'windows',
      cpuCores: 8,
      ramMb: 16384,
      gpus: [],
      engines: null,
      capabilities: null,
      freeSlots: { cpu: 2, gpu: 1 },
      runningJobIds: ['j1'],
      limits: null,
      schedule: null,
      lastSeenAt: at,
      agentVersion: '0.1.0',
      createdAt: at,
      updatedAt: at,
    } as FarmNodeEntity;

    const view = toNodeView(node, true);

    expect(view).toMatchObject({
      cpu_cores: 8,
      ram_mb: 16384,
      free_slots: { cpu: 2, gpu: 1 },
      running_job_ids: ['j1'],
      last_seen_at: at.toISOString(),
      agent_version: '0.1.0',
      online: true,
    });
    expect(JSON.stringify(view)).not.toMatch(/token|Hash/);
  });

  it('node chưa từng kết nối: last_seen_at null', () => {
    const node = {
      id: 'n2',
      name: 'x',
      machine: '',
      kinds: [],
      runningJobIds: [],
      lastSeenAt: null,
      createdAt: at,
      updatedAt: at,
    } as unknown as FarmNodeEntity;
    expect(toNodeView(node, false)).toMatchObject({ last_seen_at: null, running_job_ids: [] });
  });

  it('trả chủ job dạng snake_case, không kèm hash khoá', () => {
    const owner = {
      id: 'studio',
      keyHash: 'b'.repeat(64),
      signUrl: 'http://api/farm/sign',
      allowedTypes: ['studio.tts'],
      defaultLane: 'interactive',
      createdAt: at,
      updatedAt: at,
    } as FarmOwnerEntity;

    expect(toOwnerView(owner)).toEqual({
      id: 'studio',
      sign_url: 'http://api/farm/sign',
      allowed_types: ['studio.tts'],
      default_lane: 'interactive',
      created_at: at.toISOString(),
      updated_at: at.toISOString(),
    });
  });
});
