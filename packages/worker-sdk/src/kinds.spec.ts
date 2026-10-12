import type { Capabilities } from '@ag-farm/protocol';
import { workerKinds } from './kinds';

const handler = async () => ({ manifest: null, summary: {} });

const cpuBox: Capabilities = {
  os: 'windows',
  cpu_cores: 8,
  ram_mb: 16384,
  gpus: [],
  engines: { ffmpeg: '7.1', ollama_models: [], python: null },
};
const gpuBox: Capabilities = {
  ...cpuBox,
  gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true, nvdec: true }],
  engines: { ffmpeg: '7.1', ollama_models: [], python: '3.11.9', ytdlp: '2026.08.19' },
};

const render = {
  'studio.tts': handler,
  'studio.render_preview': handler,
  'studio.render_final': handler,
  'studio.export_premiere': handler,
  'studio.transcribe': handler,
};

describe('workerKinds', () => {
  it('without kinds in config: every handled kind the machine can run', () => {
    expect(workerKinds(render, gpuBox)).toEqual([
      'studio.tts',
      'studio.render_preview',
      'studio.render_final',
      'studio.export_premiere',
      'studio.transcribe',
    ]);
  });

  it('a machine without GPU or Python leaves out TTS and transcribe', () => {
    expect(workerKinds(render, cpuBox)).toEqual(['studio.render_preview', 'studio.render_final', 'studio.export_premiere']);
    const gpuNoPython = { ...gpuBox, engines: { ...gpuBox.engines, python: null } };
    expect(workerKinds(render, gpuNoPython)).not.toContain('studio.tts');
  });

  it('scan.ai needs a GPU', () => {
    const scan = { 'scan.extract': handler, 'scan.ai': handler };
    expect(workerKinds(scan, cpuBox)).toEqual(['scan.extract']);
    expect(workerKinds(scan, gpuBox)).toEqual(['scan.extract', 'scan.ai']);
  });

  it('kinds in config override, but only kinds the worker has a handler for', () => {
    expect(workerKinds(render, gpuBox, ['studio.render_final', 'scan.ai'])).toEqual(['studio.render_final']);
    // forced even when the machine does not meet it: the hub still checks every job's requirements
    expect(workerKinds(render, cpuBox, ['studio.tts'])).toEqual(['studio.tts']);
    expect(workerKinds(render, gpuBox, ['scan.ai'])).toEqual([]);
  });

  it('a machine that meets no kind still reports its handlers, so it shows Online', () => {
    expect(workerKinds({ 'scan.ai': handler }, cpuBox)).toEqual(['scan.ai']);
  });

  it('ignores handler slots left undefined', () => {
    expect(workerKinds({ 'scan.extract': handler, 'scan.ai': undefined }, gpuBox)).toEqual(['scan.extract']);
  });
});
