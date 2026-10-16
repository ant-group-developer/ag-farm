import { detectCapabilities, detectPython, detectYtdlp, type PythonExec } from './capabilities';

function fakeExec(answers: Record<string, string | Error>): { exec: PythonExec; calls: string[] } {
  const calls: string[] = [];
  const exec: PythonExec = async (file, args) => {
    calls.push(file);
    expect(args).toEqual(['-c', 'import torch,sys;print(sys.version.split()[0])']);
    const answer = answers[file];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`ENOENT ${file}`);
    return { stdout: answer };
  };
  return { exec, calls };
}

describe('detectPython', () => {
  it('runs exactly the given interpreter and reports its version', async () => {
    const { exec, calls } = fakeExec({ 'E:/venv/Scripts/python.exe': '3.11.9\n' });
    await expect(detectPython('E:/venv/Scripts/python.exe', exec)).resolves.toBe('3.11.9');
    expect(calls).toEqual(['E:/venv/Scripts/python.exe']);
  });

  it('does not fall back to PATH when the given interpreter has no torch', async () => {
    const { exec, calls } = fakeExec({ 'E:/venv/Scripts/python.exe': new Error('No module named torch'), python: '3.14.0' });
    await expect(detectPython('E:/venv/Scripts/python.exe', exec)).resolves.toBeNull();
    expect(calls).toEqual(['E:/venv/Scripts/python.exe']);
  });

  it('without an interpreter tries python, then python3, on PATH', async () => {
    const { exec, calls } = fakeExec({ python3: '3.12.1' });
    await expect(detectPython(undefined, exec)).resolves.toBe('3.12.1');
    expect(calls).toEqual(['python', 'python3']);
  });

  it('gives a cold torch import 30 s, not the 8 s of the other probes', async () => {
    const timeouts: (number | undefined)[] = [];
    const exec: PythonExec = async (_file, _args, opts) => { timeouts.push(opts?.timeout); return { stdout: '3.11.9' }; };
    await detectPython('E:/venv/Scripts/python.exe', exec);
    expect(timeouts).toEqual([30_000]);
  });

  it('reports nothing when no interpreter has torch', async () => {
    const { exec } = fakeExec({});
    await expect(detectPython(undefined, exec)).resolves.toBeNull();
  });
});

describe('detectYtdlp', () => {
  it('runs the given yt-dlp and reports its version', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: PythonExec = async (file, args) => { calls.push({ file, args }); return { stdout: '2026.08.19\r\n' }; };
    await expect(detectYtdlp('C:/ag-farm/venv/Scripts/yt-dlp.exe', exec)).resolves.toBe('2026.08.19');
    expect(calls).toEqual([{ file: 'C:/ag-farm/venv/Scripts/yt-dlp.exe', args: ['--version'] }]);
  });

  it('reports nothing when yt-dlp does not run', async () => {
    const exec: PythonExec = async () => { throw new Error('ENOENT'); };
    await expect(detectYtdlp('yt-dlp', exec)).resolves.toBeNull();
  });
});

describe('detectCapabilities', () => {
  it('does not send engines.ytdlp when it was not asked for or not found (older hubs reject the key)', async () => {
    const caps = await detectCapabilities({ ffmpegPath: 'no-such-ffmpeg-xyz', ollamaUrl: 'http://127.0.0.1:1', ytdlpBin: 'no-such-yt-dlp-xyz' });
    expect('ytdlp' in caps.engines).toBe(false);
    expect(caps.engines.ffmpeg).toBeNull();
    expect('studio_render' in caps.engines).toBe(false);
  }, 30_000);

  it('sends engines.studio_render when the worker says its level', async () => {
    const caps = await detectCapabilities({ ffmpegPath: 'no-such-ffmpeg-xyz', ollamaUrl: 'http://127.0.0.1:1', studioRender: 1 });
    expect(caps.engines.studio_render).toBe(1);
  }, 30_000);
});
