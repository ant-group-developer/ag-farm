import {
  MachineSampler,
  counterRate,
  parseNetstatE,
  parseNvidiaSmi,
  parseProcNetDev,
} from './metrics';
import type { MetricsProbes } from './metrics';

const GB = 1024 ** 3;

/** Máy giả: mọi số đo do test đặt, không đụng phần cứng thật. */
function fakeMachine(platform: NodeJS.Platform) {
  const state = {
    now: 1_000_000,
    cpu: { idle: 1000, total: 2000 },
    mem: { total: 32 * GB, free: 8 * GB },
    netstat: { rx: 1_000_000, tx: 500_000 },
    procNet: { rx: 10_000, tx: 20_000 },
    smi: '0, 45, 3000, 8192, 61\n',
    smiMissing: false,
    execs: [] as string[],
  };
  const devices: Record<string, number> = {
    [platform === 'win32' ? 'C:\\farm' : '/srv/farm']: 1,
    [platform === 'win32' ? 'D:\\cache' : '/mnt/cache']: 2,
  };
  const probes: Partial<MetricsProbes> = {
    platform,
    now: () => state.now,
    cpuTimes: () => ({ ...state.cpu }),
    memory: () => ({ ...state.mem }),
    uptime: () => 3600.7,
    device: async (path) => {
      const dev = devices[path];
      if (dev === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return dev;
    },
    statfs: async (path) =>
      devices[path] === 1
        ? { bsize: 4096, blocks: (500 * GB) / 4096, bavail: (100 * GB) / 4096 }
        : { bsize: 4096, blocks: (1000 * GB) / 4096, bavail: (10 * GB) / 4096 },
    readFile: async () =>
      [
        'Inter-|   Receive                                                |  Transmit',
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
        `    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0`,
        `  eth0: ${state.procNet.rx} 10 0 0 0 0 0 0 ${state.procNet.tx} 10 0 0 0 0 0 0`,
        `docker0: 5555 1 0 0 0 0 0 0 5555 1 0 0 0 0 0 0`,
      ].join('\n'),
    exec: async (file) => {
      state.execs.push(file);
      if (file === 'nvidia-smi') {
        if (state.smiMissing) throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' });
        return { stdout: state.smi };
      }
      if (file === 'netstat') {
        return {
          stdout: `Interface Statistics\r\n\r\n                           Received            Sent\r\n\r\nBytes                    ${state.netstat.rx}      ${state.netstat.tx}\r\nUnicast packets           240759724        62150308\r\n`,
        };
      }
      throw new Error(`unexpected ${file}`);
    },
  };
  return { state, probes };
}

describe('parsers', () => {
  it('reads nvidia-smi rows and drops what the card does not report', () => {
    expect(parseNvidiaSmi('0, 7, 1385, 4096, 55\r\n1, [N/A], 100, 24576, [Not Supported]\r\n\r\n')).toEqual([
      { index: 0, util_pct: 7, vram_used_mb: 1385, vram_total_mb: 4096, temp_c: 55 },
      { index: 1, vram_used_mb: 100, vram_total_mb: 24576 },
    ]);
    expect(parseNvidiaSmi('garbage')).toEqual([]);
  });

  it('reads the byte line of netstat -e whatever its label says', () => {
    expect(parseNetstatE('Interface Statistics\n\n   Received   Sent\n\nBytes  1202965496  3449804736\nUnicast packets 1 2\n')).toEqual({
      rx: 1202965496,
      tx: 3449804736,
    });
    expect(parseNetstatE('Thống kê\n\nByte  10  20\n')).toEqual({ rx: 10, tx: 20 });
    expect(parseNetstatE('nothing here')).toBeNull();
  });

  it('sums real interfaces of /proc/net/dev, not loopback or bridges', () => {
    const content = [
      'Inter-| Receive | Transmit',
      ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets',
      '    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0',
      '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0',
      '  wlan0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0',
      ' veth12ab: 7 1 0 0 0 0 0 0 7 1 0 0 0 0 0 0',
    ].join('\n');
    expect(parseProcNetDev(content)).toEqual({ rx: 1010, tx: 2020 });
    expect(parseProcNetDev('')).toBeNull();
  });

  it('turns counters into bytes per second, across one 32-bit wrap', () => {
    expect(counterRate(1000, 4000, 30, false)).toBe(100);
    expect(counterRate(2 ** 32 - 100, 200, 10, true)).toBe(30);
    // Bộ đếm 64 bit tụt về (card khởi động lại): không đoán
    expect(counterRate(5000, 100, 10, false)).toBeUndefined();
    expect(counterRate(1, 2, 0, false)).toBeUndefined();
  });
});

describe('MachineSampler', () => {
  it('measures CPU from the change since the last sample, RAM, disks, uptime', async () => {
    const { state, probes } = fakeMachine('linux');
    const s = new MachineSampler({ dirs: ['/srv/farm/work', '/srv/farm', '/mnt/cache/dl'], gpu: false, probes });
    const first = await s.sample();
    expect(first.cpu_pct).toBeUndefined(); // chưa có lần trước để so
    expect(first.ram_total_mb).toBe(32 * 1024);
    expect(first.ram_used_mb).toBe(24 * 1024);
    // work_dir chưa có thì đo thư mục cha; hai thư mục cùng ổ chỉ một dòng
    expect(first.disks).toEqual([
      { path: '/srv/farm', free_mb: 100 * 1024, total_mb: 500 * 1024 },
      { path: '/mnt/cache', free_mb: 10 * 1024, total_mb: 1000 * 1024 },
    ]);
    expect(first.uptime_s).toBe(3600);

    state.now += 15_000;
    state.cpu = { idle: 1000 + 300, total: 2000 + 1000 };
    const second = await s.sample();
    expect(second.cpu_pct).toBe(70);
    expect(s.latest()).toEqual(second);
  });

  it('Linux: network from /proc/net/dev every sample, GPU from nvidia-smi', async () => {
    const { state, probes } = fakeMachine('linux');
    const s = new MachineSampler({ dirs: ['/srv/farm'], probes });
    expect((await s.sample()).net_rx_bps).toBeUndefined();
    state.now += 10_000;
    state.procNet = { rx: 10_000 + 50_000, tx: 20_000 + 10_000 };
    const m = await s.sample();
    expect(m.net_rx_bps).toBe(5000);
    expect(m.net_tx_bps).toBe(1000);
    expect(m.gpus).toEqual([{ index: 0, util_pct: 45, vram_used_mb: 3000, vram_total_mb: 8192, temp_c: 61 }]);
    expect(state.execs).toEqual(['nvidia-smi', 'nvidia-smi']);
  });

  it('Windows: one command per sample, GPU and netstat take turns and their last reading carries over', async () => {
    const { state, probes } = fakeMachine('win32');
    const s = new MachineSampler({ dirs: ['C:\\farm\\work', 'D:\\cache'], probes });
    const execsPerSample: number[] = [];
    const run = async () => {
      const before = state.execs.length;
      const m = await s.sample();
      execsPerSample.push(state.execs.length - before);
      state.now += 15_000;
      return m;
    };
    const a = await run(); // nvidia-smi
    expect(a.gpus?.[0]?.util_pct).toBe(45);
    expect(a.disks?.map((d) => d.path)).toEqual(['C:', 'D:']);
    await run(); // netstat (first counters)
    state.smi = '0, 99, 8000, 8192, 80\n';
    const c = await run(); // nvidia-smi
    expect(c.gpus?.[0]?.util_pct).toBe(99);
    state.netstat = { rx: 1_000_000 + 3_000_000, tx: 500_000 + 300_000 };
    const d = await run(); // netstat: 30 s after the first reading
    expect(d.net_rx_bps).toBe(100_000);
    expect(d.net_tx_bps).toBe(10_000);
    expect(d.gpus?.[0]?.util_pct).toBe(99); // carried over from the previous sample
    expect(execsPerSample).toEqual([1, 1, 1, 1]);
    expect(state.execs).toEqual(['nvidia-smi', 'netstat', 'nvidia-smi', 'netstat']);
  });

  it('a machine without nvidia-smi stops trying it and omits GPU readings', async () => {
    const { state, probes } = fakeMachine('win32');
    state.smiMissing = true;
    const errors: string[] = [];
    const s = new MachineSampler({ dirs: ['C:\\farm'], probes, onError: (what) => errors.push(what) });
    for (let i = 0; i < 4; i++) {
      const m = await s.sample();
      expect(m.gpus).toBeUndefined();
      state.now += 15_000;
    }
    expect(state.execs).toEqual(['nvidia-smi', 'netstat', 'netstat', 'netstat']);
    expect(errors).toEqual(['gpu']);
  });

  it('readings that fail are left out, never sent as zero', async () => {
    const { probes } = fakeMachine('linux');
    const s = new MachineSampler({
      dirs: ['/nowhere'],
      gpu: false,
      probes: {
        ...probes,
        memory: () => {
          throw new Error('no meminfo');
        },
        device: async () => {
          throw new Error('no fs');
        },
        readFile: async () => {
          throw new Error('no proc');
        },
      },
    });
    const m = await s.sample();
    expect(m).toEqual({ uptime_s: 3600 });
  });

  it('latest() gives nothing once the last sample is too old', async () => {
    const { state, probes } = fakeMachine('linux');
    const s = new MachineSampler({ dirs: [], gpu: false, probes });
    expect(s.latest()).toBeUndefined();
    await s.sample();
    expect(s.latest()).toBeDefined();
    state.now += 3 * 60_000;
    expect(s.latest()).toBeUndefined();
  });

  it('a sample still running (command hanging) makes the next tick skip', async () => {
    const { probes } = fakeMachine('linux');
    let release!: () => void;
    let calls = 0;
    const s = new MachineSampler({
      dirs: [],
      probes: {
        ...probes,
        exec: () => {
          calls++;
          return new Promise((resolve) => {
            release = () => resolve({ stdout: '0, 1, 1, 1, 1' });
          });
        },
      },
    });
    const first = s.tick();
    await s.tick();
    expect(calls).toBe(1);
    release();
    await first;
    expect(s.latest()?.gpus).toEqual([{ index: 0, util_pct: 1, vram_used_mb: 1, vram_total_mb: 1, temp_c: 1 }]);
  });
});
