import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isOutdated,
  latestFor,
  missingTools,
  nodePackage,
  visibleUpdate,
} from '../modules/nodes/node-update';
import type { NodeCapabilities, ReleaseManifest } from '../types/api';

const latest: ReleaseManifest = {
  packages: {
    'ag-render-worker': { version: '0.9.1', file: 'r.zip', sha256: 'a'.repeat(64), size_bytes: 1 },
    'ag-scan-worker': { version: '0.4.0', file: 's.zip', sha256: 'b'.repeat(64), size_bytes: 1 },
  },
};

const caps = (over: Partial<NodeCapabilities['engines']> = {}, gpus: NodeCapabilities['gpus'] = []): NodeCapabilities => ({
  os: 'windows',
  cpu_cores: 8,
  ram_mb: 16384,
  gpus,
  engines: { ffmpeg: '7.0', ollama_models: [], python: null, ...over },
});

describe('node update', () => {
  it('knows the package from the installer name, else from the kinds', () => {
    expect(nodePackage({ name: 'pc1-render', kinds: [] })).toBe('ag-render-worker');
    expect(nodePackage({ name: 'pc1-scan', kinds: [] })).toBe('ag-scan-worker');
    expect(nodePackage({ name: 'manual', kinds: ['studio.tts'] })).toBe('ag-render-worker');
    expect(nodePackage({ name: 'manual', kinds: ['scan.ai'] })).toBe('ag-scan-worker');
    expect(nodePackage({ name: 'manual', kinds: [] })).toBeNull();
  });

  it('compares versions like semver', () => {
    expect(compareVersions('0.8.1', '0.9.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.1')).toBeGreaterThan(0);
    expect(compareVersions('0.9.1-rc.1', '0.9.1')).toBeLessThan(0);
    expect(compareVersions('0.9.1', '0.9.1')).toBe(0);
  });

  it('a node is old when its package has a newer release', () => {
    expect(latestFor({ name: 'pc1-render', kinds: [] }, latest)).toBe('0.9.1');
    expect(isOutdated({ name: 'pc1-render', kinds: [], agent_version: '0.8.1' }, latest)).toBe(true);
    expect(isOutdated({ name: 'pc1-render', kinds: [], agent_version: '0.9.1' }, latest)).toBe(false);
    expect(isOutdated({ name: 'pc1-scan', kinds: [], agent_version: '0.3.5' }, latest)).toBe(true);
    expect(isOutdated({ name: 'pc1-render', kinds: [], agent_version: null }, latest)).toBe(false);
    expect(isOutdated({ name: 'pc1-render', kinds: [], agent_version: '0.8.1' }, undefined)).toBe(false);
  });

  it('a render node lists what it lacks; a full one and scan nodes list nothing', () => {
    expect(missingTools({ name: 'pc-render', kinds: [], capabilities: caps() })).toEqual(['python', 'cuda', 'ytdlp', 'nvenc']);
    const gpu = [{ name: 'RTX 4060 Ti', vram_mb: 16380, nvenc: true, nvdec: true }];
    expect(missingTools({ name: 'pc-render', kinds: [], capabilities: caps({ python: '3.11.9', ytdlp: '2026.08.19' }, gpu) })).toEqual([]);
    expect(missingTools({ name: 'pc-render', kinds: [], capabilities: caps({ python: '3.11.9' }, gpu) })).toEqual(['ytdlp']);
    expect(missingTools({ name: 'pc-scan', kinds: [], capabilities: caps() })).toEqual([]);
    expect(missingTools({ name: 'pc-render', kinds: [], capabilities: null })).toEqual([]);
  });

  it('shows the update state unless it is a plain idle', () => {
    expect(visibleUpdate({ update: null })).toBeNull();
    expect(visibleUpdate({ update: { state: 'idle' } })).toBeNull();
    expect(visibleUpdate({ update: { state: 'idle', message: 'Updated from 0.9.0 to 0.9.1' } })?.message).toBe('Updated from 0.9.0 to 0.9.1');
    expect(visibleUpdate({ update: { state: 'failed', target_version: '0.9.1' } })?.state).toBe('failed');
  });
});
