/**
 * Test SlotAllocator: single process + stale lock + reserve_interactive.
 * Test multi-process được thực hiện qua test helpers riêng bên dưới.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { MachineConfig, SlotAllocator } from './machine';

function makeTempMachineFile(tmpDir: string, config: MachineConfig): string {
  const yaml = `
cpu_slots: ${config.cpu_slots}
gpu_slots: ${config.gpu_slots}
reserve_interactive:
  cpu: ${config.reserve_interactive.cpu}
  gpu: ${config.reserve_interactive.gpu}
`.trim();
  const machineFile = join(tmpDir, 'machine.yaml');
  writeFileSync(machineFile, yaml);
  return machineFile;
}

describe('SlotAllocator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `test-machine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases slots', () => {
    const machineFile = makeTempMachineFile(tmpDir, {
      cpu_slots: 2, gpu_slots: 1,
      reserve_interactive: { cpu: 0, gpu: 0 },
    });
    const alloc = new SlotAllocator(
      { cpu_slots: 2, gpu_slots: 1, reserve_interactive: { cpu: 0, gpu: 0 } },
      machineFile,
    );

    const h1 = alloc.acquire('cpu', { lane: 'batch' });
    const h2 = alloc.acquire('cpu', { lane: 'batch' });
    const h3 = alloc.acquire('cpu', { lane: 'batch' }); // should be null

    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h3).toBeNull();

    alloc.release(h1!);
    const h4 = alloc.acquire('cpu', { lane: 'batch' });
    expect(h4).not.toBeNull();

    alloc.release(h2!);
    alloc.release(h4!);
  });

  it('freeSlots reports correctly', () => {
    const machineFile = makeTempMachineFile(tmpDir, {
      cpu_slots: 3, gpu_slots: 1,
      reserve_interactive: { cpu: 1, gpu: 0 },
    });
    const cfg = { cpu_slots: 3, gpu_slots: 1, reserve_interactive: { cpu: 1, gpu: 0 } };
    const alloc = new SlotAllocator(cfg, machineFile);

    expect(alloc.freeSlots()).toEqual({ cpu: 3, gpu: 1 });
    const h = alloc.acquire('cpu', { lane: 'batch' });
    expect(alloc.freeSlots().cpu).toBe(2);
    alloc.release(h!);
    expect(alloc.freeSlots().cpu).toBe(3);
  });

  it('reserve_interactive: batch cannot take reserved slots', () => {
    const machineFile = makeTempMachineFile(tmpDir, {
      cpu_slots: 2, gpu_slots: 0,
      reserve_interactive: { cpu: 1, gpu: 0 },
    });
    const cfg = { cpu_slots: 2, gpu_slots: 0, reserve_interactive: { cpu: 1, gpu: 0 } };
    const alloc = new SlotAllocator(cfg, machineFile);

    // Batch chỉ được dùng slot 0 (maxForBatch = 2-1 = 1)
    const b1 = alloc.acquire('cpu', { lane: 'batch' });
    expect(b1).not.toBeNull();

    // Batch không lấy được slot 1 (dành riêng)
    const b2 = alloc.acquire('cpu', { lane: 'batch' });
    expect(b2).toBeNull();

    // Interactive lấy được slot 1
    const i1 = alloc.acquire('cpu', { lane: 'interactive' });
    expect(i1).not.toBeNull();

    alloc.release(b1!);
    alloc.release(i1!);
  });

  it('removes stale lock from dead process', () => {
    const machineFile = makeTempMachineFile(tmpDir, {
      cpu_slots: 1, gpu_slots: 0,
      reserve_interactive: { cpu: 0, gpu: 0 },
    });
    const cfg = { cpu_slots: 1, gpu_slots: 0, reserve_interactive: { cpu: 0, gpu: 0 } };
    const alloc = new SlotAllocator(cfg, machineFile);

    // Tạo lock với PID chắc chắn không tồn tại
    const lockPath = join(tmpDir, 'locks', 'cpu-0.lock');
    writeFileSync(lockPath, '999999999 12345\n');

    // acquire phải thành công vì PID đã chết (ESRCH)
    const h = alloc.acquire('cpu', { lane: 'batch' });
    expect(h).not.toBeNull();
    alloc.release(h!);
  });

  describe('interactive pressure flags', () => {
    const cfg = { cpu_slots: 2, gpu_slots: 1, reserve_interactive: { cpu: 1, gpu: 0 } };

    it('is raised while an interactive job is marked and cleared afterwards', () => {
      const alloc = new SlotAllocator(cfg, makeTempMachineFile(tmpDir, cfg));
      expect(alloc.interactivePressure()).toBe(false);
      const flag = alloc.markInteractive('job/with:odd*chars');
      expect(alloc.interactivePressure()).toBe(true);
      alloc.clearFlag(flag);
      expect(alloc.interactivePressure()).toBe(false);
    });

    it('is shared across allocators on the same machine file', () => {
      const machineFile = makeTempMachineFile(tmpDir, cfg);
      const render = new SlotAllocator(cfg, machineFile);
      const scan = new SlotAllocator(cfg, machineFile);
      render.setWanted(true);
      expect(scan.interactivePressure()).toBe(true);
      render.setWanted(false);
      expect(scan.interactivePressure()).toBe(false);
    });

    it('ignores flags of dead processes and stale wanted flags', () => {
      const alloc = new SlotAllocator(cfg, makeTempMachineFile(tmpDir, cfg));
      writeFileSync(join(tmpDir, 'locks', 'interactive-999999999-x.lock'), `999999999 ${Date.now()}
`);
      writeFileSync(join(tmpDir, 'locks', `wanted-${process.pid}.lock`), `${process.pid} ${Date.now() - 60_000}
`);
      expect(alloc.interactivePressure()).toBe(false);
    });

    it('does not count flags as used slots', () => {
      const alloc = new SlotAllocator(cfg, makeTempMachineFile(tmpDir, cfg));
      alloc.markInteractive('j1');
      alloc.setWanted(true);
      expect(alloc.freeSlots()).toEqual({ cpu: 2, gpu: 1 });
    });
  });
});
