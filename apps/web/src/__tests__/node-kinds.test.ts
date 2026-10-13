import { describe, expect, it } from 'vitest';
import { kindRows, withKind } from '../modules/nodes/node-kinds';

describe('node kinds', () => {
  it('shows every reported kind, then blocked kinds the worker no longer reports', () => {
    expect(kindRows(['studio.render_final', 'studio.tts'], ['studio.tts', 'scan.ai'])).toEqual([
      { kind: 'studio.render_final', reported: true, blocked: false },
      { kind: 'studio.tts', reported: true, blocked: true },
      { kind: 'scan.ai', reported: false, blocked: true },
    ]);
    expect(kindRows([], [])).toEqual([]);
  });

  it('turning a kind off blocks it, turning it on unblocks it', () => {
    expect(withKind([], 'scan.ai', false)).toEqual(['scan.ai']);
    expect(withKind(['scan.ai', 'studio.tts'], 'scan.ai', true)).toEqual(['studio.tts']);
    expect(withKind(['scan.ai'], 'scan.ai', false)).toEqual(['scan.ai']);
    expect(withKind([], 'scan.ai', true)).toEqual([]);
  });
});
