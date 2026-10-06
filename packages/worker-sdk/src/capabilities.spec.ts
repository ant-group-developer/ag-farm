import { detectPython, type PythonExec } from './capabilities';

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

  it('reports nothing when no interpreter has torch', async () => {
    const { exec } = fakeExec({});
    await expect(detectPython(undefined, exec)).resolves.toBeNull();
  });
});
