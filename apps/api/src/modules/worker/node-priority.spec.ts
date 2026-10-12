import type { Capabilities } from '@ag-farm/protocol';
import type { FarmJobEntity } from '../../database/entities/farm-job.entity';
import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import {
  claimableSince,
  earlierNodeFor,
  earlierReadyNodes,
  effectiveKinds,
  isAhead,
  isInsideSchedule,
  subtractLeasedSince,
} from './node-priority';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const CAPS: Capabilities = {
  os: 'linux',
  cpu_cores: 8,
  ram_mb: 16384,
  gpus: [],
  engines: { ffmpeg: '6', ollama_models: [], python: null },
};

let seq = 0;
function node(over: Partial<FarmNodeEntity> = {}): FarmNodeEntity {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `n${seq}`,
    priorityOrder: seq,
    status: 'active',
    kinds: ['scan.extract', 'scan.ai'],
    allowedKinds: null,
    capabilities: CAPS,
    freeSlots: { cpu: 2, gpu: 0 },
    schedule: null,
    lastSeenAt: new Date(NOW - 5_000),
    ...over,
  } as FarmNodeEntity;
}

function job(over: Partial<FarmJobEntity> = {}): Pick<FarmJobEntity, 'type' | 'requirements'> {
  return { type: 'scan.extract', requirements: {}, ...over };
}

describe('node priority', () => {
  it('isInsideSchedule: only { paused: true } stops a node', () => {
    expect(isInsideSchedule(null)).toBe(true);
    expect(isInsideSchedule({ weekly: [] })).toBe(true);
    expect(isInsideSchedule({ paused: true })).toBe(false);
  });

  it('effectiveKinds: reported ∩ allowed, null allows all', () => {
    expect(effectiveKinds(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(effectiveKinds(['a', 'b'], ['b', 'c'])).toEqual(['b']);
  });

  it('isAhead: smaller order first, ties broken by id so two nodes never yield to each other', () => {
    const a = { id: 'a', priorityOrder: 1 };
    const b = { id: 'b', priorityOrder: 2 };
    expect(isAhead(a, b)).toBe(true);
    expect(isAhead(b, a)).toBe(false);
    const c = { id: 'c', priorityOrder: 1 };
    expect(isAhead(a, c)).toBe(true);
    expect(isAhead(c, a)).toBe(false);
  });

  it('earlierReadyNodes: only active, online, in-schedule nodes ahead of self that reported, in order', () => {
    const second = node({ priorityOrder: 2 });
    const first = node({ priorityOrder: 1 });
    const disabled = node({ priorityOrder: 0, status: 'disabled' });
    const offline = node({ priorityOrder: 0, lastSeenAt: new Date(NOW - 120_000) });
    const neverSeen = node({ priorityOrder: 0, lastSeenAt: null });
    const paused = node({ priorityOrder: 0, schedule: { paused: true } });
    const noCaps = node({ priorityOrder: 0, capabilities: null });
    const self = node({ priorityOrder: 5 });
    const later = node({ priorityOrder: 9 });
    const ready = earlierReadyNodes(
      [second, later, disabled, offline, neverSeen, paused, noCaps, self, first],
      self,
      NOW,
      90,
    );
    expect(ready.map((e) => e.node.id)).toEqual([first.id, second.id]);
    // Bản sao: giữ chỗ trong một claim không đổi entity
    ready[0]!.free.cpu = 0;
    expect(first.freeSlots!.cpu).toBe(2);
  });

  it('subtractLeasedSince: jobs leased after the heartbeat use up the slot of their type', () => {
    const a = node({ freeSlots: { cpu: 2, gpu: 1 } });
    const ready = earlierReadyNodes([a], node({ priorityOrder: 99 }), NOW, 90);
    subtractLeasedSince(ready, [
      { node_id: a.id, type: 'scan.extract', n: '1' },
      { node_id: a.id, type: 'scan.ai', n: 3 },
      { node_id: 'other', type: 'scan.extract', n: 5 },
    ]);
    expect(ready[0]!.free).toEqual({ cpu: 1, gpu: 0 });
  });

  it('earlierNodeFor: the first earlier node that takes the type, meets requirements and has the slot', () => {
    const full = node({ freeSlots: { cpu: 0, gpu: 0 } });
    const noKind = node({ allowedKinds: ['scan.ai'] });
    const windowsOnly = node({ capabilities: { ...CAPS, os: 'windows' } });
    const ok = node();
    const ready = earlierReadyNodes([full, noKind, windowsOnly, ok], node({ priorityOrder: 99 }), NOW, 90);
    expect(earlierNodeFor(job(), ready)?.node.id).toBe(windowsOnly.id);
    expect(earlierNodeFor(job({ requirements: { os: 'linux' } }), ready)?.node.id).toBe(ok.id);
    // scan.ai cần GPU, không máy nào có
    expect(earlierNodeFor(job({ type: 'scan.ai', requirements: { gpu: true } }), ready)).toBeNull();
  });

  it('earlierNodeFor: a job pinned to a node never yields', () => {
    const ready = earlierReadyNodes([node()], node({ priorityOrder: 99 }), NOW, 90);
    expect(earlierNodeFor(job({ requirements: { node_id: '00000000-0000-4000-8000-0000000000ff' } }), ready)).toBeNull();
  });

  it('claimableSince: the latest of created, requeued (updated) and not_before', () => {
    const t = (s: number) => new Date(NOW + s * 1000);
    expect(claimableSince({ createdAt: t(0), updatedAt: t(0), notBefore: null })).toBe(NOW);
    expect(claimableSince({ createdAt: t(0), updatedAt: t(30), notBefore: null })).toBe(NOW + 30_000);
    expect(claimableSince({ createdAt: t(0), updatedAt: t(30), notBefore: t(60) })).toBe(NOW + 60_000);
  });
});
