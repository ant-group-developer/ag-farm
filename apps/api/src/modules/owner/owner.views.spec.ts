import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { toOwnerNodeView } from './owner.views';

const node = (over: Partial<FarmNodeEntity> = {}) =>
  ({
    id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'render-01', machine: 'DESKTOP-1', status: 'active',
    kinds: ['studio.render_final', 'studio.tts', 'scan.extract'], allowedKinds: null,
    gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true, nvdec: true }], runningJobIds: ['j1'],
    lastSeenAt: new Date('2026-10-07T10:00:00.000Z'), ...over,
  }) as FarmNodeEntity;

describe('toOwnerNodeView', () => {
  it('shows only the kinds the owner sends and the node takes, with GPUs and load', () => {
    expect(toOwnerNodeView(node(), true, ['studio.render_final', 'studio.tts'])).toEqual({
      id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'render-01', online: true, kinds: ['studio.render_final', 'studio.tts'],
      gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true }], running_jobs: 1, last_seen_at: '2026-10-07T10:00:00.000Z',
    });
  });

  it('an admin limit on the node counts', () => {
    expect(toOwnerNodeView(node({ allowedKinds: ['studio.tts'] }), true, ['studio.render_final', 'studio.tts'])?.kinds).toEqual(['studio.tts']);
  });

  it('a disabled node, or one taking none of the owner’s types, is not shown', () => {
    expect(toOwnerNodeView(node({ status: 'disabled' }), true, ['studio.render_final'])).toBeNull();
    expect(toOwnerNodeView(node(), true, ['scan.ai'])).toBeNull();
  });
});
