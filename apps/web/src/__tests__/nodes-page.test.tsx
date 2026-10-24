import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import { jobTypeLabel } from '../shared/lib/job-labels';
import type { NodeView } from '../types/api';

const listNodes = vi.fn();
const patchNode = vi.fn();
const requestNodeUpdate = vi.fn();
const getLatestReleases = vi.fn();
const getMachineMetrics = vi.fn();
const listNodeLogs = vi.fn();
const requestNodeLogs = vi.fn();
const downloadNodeLog = vi.fn();
vi.mock('../api/admin', () => ({
  listNodes: (...args: unknown[]) => listNodes(...args),
  createNode: vi.fn(),
  patchNode: (...args: unknown[]) => patchNode(...args),
  deleteNode: vi.fn(),
  reorderNodes: vi.fn(),
  createEnrollment: vi.fn(),
  requestNodeUpdate: (...args: unknown[]) => requestNodeUpdate(...args),
  getLatestReleases: (...args: unknown[]) => getLatestReleases(...args),
  getMachineMetrics: (...args: unknown[]) => getMachineMetrics(...args),
  listNodeLogs: (...args: unknown[]) => listNodeLogs(...args),
  requestNodeLogs: (...args: unknown[]) => requestNodeLogs(...args),
  downloadNodeLog: (...args: unknown[]) => downloadNodeLog(...args),
}));

const { NodesPage } = await import('../modules/nodes/NodesPage');

function node(name: string, priority_order: number, over: Partial<NodeView> = {}): NodeView {
  return {
    id: `id-${name}`,
    name,
    machine: 'PC',
    kinds: ['scan.extract'],
    blocked_kinds: [],
    status: 'active',
    priority_order,
    os: 'windows',
    cpu_cores: 8,
    ram_mb: 16384,
    gpus: [],
    engines: null,
    capabilities: null,
    free_slots: { cpu: 2, gpu: 0 },
    running_job_ids: [],
    limits: null,
    schedule: null,
    last_seen_at: null,
    agent_version: '1.0',
    auto_update: true,
    update_requested_at: null,
    update: null,
    update_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    online: true,
    ...over,
  };
}

function renderPage(search = '') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <NuqsTestingAdapter searchParams={search}>
      <QueryClientProvider client={qc}>
        <NodesPage />
      </QueryClientProvider>
    </NuqsTestingAdapter>,
  );
}

beforeAll(async () => {
  // antd đọc matchMedia khi dựng bảng
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  await i18n.changeLanguage('vi');
});

beforeEach(() => {
  getLatestReleases.mockResolvedValue({ packages: {} });
});

describe('NodesPage', () => {
  it('mặc định xem theo thứ tự, tải cả danh sách và có tay nắm kéo thả', async () => {
    listNodes.mockResolvedValue({
      items: [node('a', 1), node('b', 2, { online: false, running_job_ids: ['j1', 'j2'] })],
      total: 2,
      page: 1,
      pageSize: 200,
    });
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('a').length).toBeGreaterThan(0));
    expect(listNodes).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'priorityOrder', sortOrder: 'asc', page: 1, pageSize: 200 }),
    );
    expect(screen.getAllByText('Thứ tự').length).toBeGreaterThan(0);
    // Mỗi dòng có tay nắm kéo thả (lucide GripVertical)
    expect(container.querySelectorAll('svg.lucide-grip-vertical')).toHaveLength(2);
    // Số job đang chạy
    expect(container.querySelector('.ant-badge-count')?.textContent).toContain('2');
  });

  it('tải lại có dữ liệu mới thì cập nhật ô tại chỗ, không dựng lại bảng (không nháy)', async () => {
    listNodes.mockResolvedValue({ items: [node('a', 1), node('b', 2)], total: 2, page: 1, pageSize: 200 });
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('a').length).toBeGreaterThan(0));
    const rowBefore = container.querySelector('tr[data-row-key="id-a"]');
    expect(rowBefore).not.toBeNull();

    listNodes.mockResolvedValue({
      items: [node('a', 1, { agent_version: '2.0' }), node('b', 2)],
      total: 2,
      page: 1,
      pageSize: 200,
    });
    fireEvent.click(screen.getByRole('button', { name: /tải lại|làm mới/i }));
    await waitFor(() => expect(screen.getAllByText('2.0').length).toBeGreaterThan(0));
    expect(container.querySelector('tr[data-row-key="id-a"]')).toBe(rowBefore);
  });

  it('sắp theo cột khác thì không kéo thả và phân trang như cũ', async () => {
    listNodes.mockResolvedValue({ items: [node('a', 1), node('b', 2)], total: 2, page: 1, pageSize: 20 });
    const { container } = renderPage('?sortBy=name');
    await waitFor(() => expect(screen.getAllByText('a').length).toBeGreaterThan(0));
    expect(listNodes).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'name', pageSize: 20 }));
    expect(container.querySelectorAll('svg.lucide-grip-vertical')).toHaveLength(0);
  });

  it('mỗi loại job máy báo có một công tắc; tắt thì gửi blocked_kinds', async () => {
    patchNode.mockResolvedValue({});
    listNodes.mockResolvedValue({
      items: [node('a', 1, { kinds: ['scan.extract', 'scan.ai'], blocked_kinds: ['scan.ai', 'studio.tts'] })],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    renderPage();
    const extract = await screen.findByRole('switch', { name: jobTypeLabel('scan.extract') });
    const ai = screen.getByRole('switch', { name: jobTypeLabel('scan.ai') });
    // studio.tts đã chặn dù máy không còn báo: vẫn hiện để bật lại
    const tts = screen.getByRole('switch', { name: jobTypeLabel('studio.tts') });
    expect(extract.getAttribute('aria-checked')).toBe('true');
    expect(ai.getAttribute('aria-checked')).toBe('false');
    expect(tts.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(extract);
    await waitFor(() =>
      expect(patchNode).toHaveBeenCalledWith('id-a', { blocked_kinds: ['scan.ai', 'studio.tts', 'scan.extract'] }),
    );
    await waitFor(() => expect(screen.getByRole('switch', { name: jobTypeLabel('scan.ai') }).className).not.toContain('loading'));
    fireEvent.click(screen.getByRole('switch', { name: jobTypeLabel('scan.ai') }));
    await waitFor(() => expect(patchNode).toHaveBeenLastCalledWith('id-a', { blocked_kinds: ['studio.tts'] }));
  }, 30_000);

  it('phiên bản cũ có tag "cũ", trạng thái cập nhật, công tắc tự cập nhật và nút Cập nhật ngay', async () => {
    getLatestReleases.mockResolvedValue({
      packages: { 'ag-render-worker': { version: '0.9.1', file: 'r.zip', sha256: 'a'.repeat(64), size_bytes: 1 } },
    });
    patchNode.mockResolvedValue({});
    requestNodeUpdate.mockResolvedValue({});
    listNodes.mockResolvedValue({
      items: [
        node('pc1-render', 1, {
          kinds: ['studio.render_final'],
          agent_version: '0.9.0',
          update: { state: 'failed', target_version: '0.9.1', message: 'no heartbeat in 3 min | setup.log: pip failed' },
          capabilities: {
            os: 'windows',
            cpu_cores: 8,
            ram_mb: 16384,
            gpus: [],
            engines: { ffmpeg: '7.0', ollama_models: [], python: null },
          },
        }),
        node('pc2-render', 2, { kinds: ['studio.render_final'], agent_version: '0.9.1', update: { state: 'idle' } }),
        node('pc3-render', 3, { kinds: ['studio.render_final'], agent_version: '0.8.1', update: null }),
      ],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText('cũ')).toHaveLength(2));
    expect(screen.getByText('Cập nhật 0.9.1 lỗi')).toBeTruthy();
    // Máy render thiếu Python, CUDA, yt-dlp, NVENC
    for (const tool of ['Python', 'CUDA', 'yt-dlp', 'NVENC']) expect(screen.getAllByText(tool).length).toBeGreaterThan(0);

    const switches = screen.getAllByRole('switch', { name: 'Tự cập nhật' });
    expect(switches).toHaveLength(3);
    fireEvent.click(switches[0]!);
    await waitFor(() => expect(patchNode).toHaveBeenCalledWith('id-pc1-render', { auto_update: false }));

    const buttons = screen.getAllByRole('button', { name: /Cập nhật ngay/ });
    // pc1: cũ, lỗi -> thử lại được; pc2: đã mới nhất; pc3: bản chưa tự cập nhật được
    expect(buttons.map((b) => (b as HTMLButtonElement).disabled)).toEqual([false, true, true]);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(requestNodeUpdate).toHaveBeenCalledWith('id-pc1-render'));
  }, 30_000);

  it('cột tình trạng máy: số, màu theo ngưỡng, số đo cũ bị làm mờ, đầu trang báo gộp theo máy', async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const fullDisk = { path: 'D:', free_mb: 12 * 1024, total_mb: 1000 * 1024 };
    listNodes.mockResolvedValue({
      items: [
        node('PC1-render', 1, {
          machine: 'PC1',
          metrics_at: now,
          metrics: {
            cpu_pct: 37,
            ram_used_mb: 15 * 1024,
            ram_total_mb: 16 * 1024,
            disks: [fullDisk],
            net_rx_bps: 1_250_000,
            net_tx_bps: 40_000,
            gpus: [{ index: 0, util_pct: 88, vram_used_mb: 6144, vram_total_mb: 8192, temp_c: 71 }],
          },
        }),
        node('PC1-scan', 2, {
          machine: 'PC1',
          metrics_at: now,
          metrics: { cpu_pct: 35, ram_used_mb: 15 * 1024, ram_total_mb: 16 * 1024, disks: [fullDisk] },
        }),
        node('PC2-render', 3, {
          machine: 'PC2',
          metrics_at: now,
          metrics: { cpu_pct: 5, ram_used_mb: 4 * 1024, ram_total_mb: 16 * 1024, disks: [fullDisk] },
        }),
        node('PC3-render', 4, {
          machine: 'PC3',
          metrics_at: old,
          metrics: { cpu_pct: 99, ram_used_mb: 16 * 1024, ram_total_mb: 16 * 1024 },
        }),
        node('PC4-render', 5, { machine: 'PC4' }),
      ],
      total: 5,
      page: 1,
      pageSize: 200,
    });
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('PC1-render').length).toBeGreaterThan(0));
    // Header: per machine (PC1 counts once), stale PC3 left out
    expect(screen.getByText('2 máy sắp đầy ổ')).toBeTruthy();
    expect(screen.getByText('1 máy RAM > 90 %')).toBeTruthy();
    expect(screen.queryByText(/CPU ≥ 95/)).toBeNull();
    // Cells
    expect(screen.getByText('37%')).toBeTruthy();
    expect(screen.getAllByText('trống 12 GB').length).toBe(3);
    // Dưới 20 GB trống: đỏ; RAM 94 %: vàng; CPU 37 %: màu thường
    expect(screen.getAllByText('trống 12 GB')[0]!.style.color).not.toBe('');
    expect(screen.getAllByText('94%')[0]!.style.color).not.toBe('');
    expect(screen.getByText('37%').style.color).toBe('');
    expect(screen.getByText('↓ 1.3 MB/s')).toBeTruthy();
    expect(screen.getByText('↑ 40.0 kB/s')).toBeTruthy();
    expect(screen.getByText('88%')).toBeTruthy();
    expect(screen.getByText(/VRAM 6 \/ 8 GB/)).toBeTruthy();
    // PC3's reading is old: greyed
    const stale = [...container.querySelectorAll('[data-stale]')];
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.some((el) => el.textContent?.includes('99%'))).toBe(true);
    expect(stale.some((el) => el.textContent?.includes('37%'))).toBe(false);
  }, 30_000);

  it('sắp theo CPU thì máy cao nhất lên đầu, máy chưa có số đo cuối, và tắt kéo thả', async () => {
    const now = new Date().toISOString();
    listNodes.mockResolvedValue({
      items: [
        node('low', 1, { metrics_at: now, metrics: { cpu_pct: 10 } }),
        node('none', 2),
        node('high', 3, { metrics_at: now, metrics: { cpu_pct: 90 } }),
      ],
      total: 3,
      page: 1,
      pageSize: 200,
    });
    const { container } = renderPage();
    await waitFor(() => expect(screen.getAllByText('low').length).toBeGreaterThan(0));
    expect(container.querySelectorAll('svg.lucide-grip-vertical')).toHaveLength(3);
    const rowNames = () =>
      [...container.querySelectorAll('tbody tr.ant-table-row')].map((tr) =>
        ['low', 'none', 'high'].find((n) => tr.textContent?.includes(n)),
      );
    expect(rowNames()).toEqual(['low', 'none', 'high']);
    const cpuHeader = [...container.querySelectorAll('th')].find((th) => th.textContent?.trim().startsWith('CPU'))!;
    fireEvent.click(cpuHeader);
    await waitFor(() => expect(rowNames()).toEqual(['high', 'low', 'none']));
    expect(container.querySelectorAll('svg.lucide-grip-vertical')).toHaveLength(0);
  }, 30_000);

  it('bấm tên máy mở drawer biểu đồ của máy đó', async () => {
    const now = new Date().toISOString();
    getMachineMetrics.mockResolvedValue({
      machine: 'PC1',
      range: '1h',
      bucket_seconds: 60,
      from: now,
      to: now,
      points: [
        {
          t: now,
          cpu_pct: 20,
          ram_used_mb: 1024,
          ram_total_mb: 2048,
          disk_free_mb: 5000,
          disk_total_mb: 9000,
          net_rx_bps: 10,
          net_tx_bps: 5,
          gpus: [],
        },
      ],
    });
    listNodes.mockResolvedValue({
      items: [
        node('PC1-render', 1, {
          machine: 'PC1',
          metrics_at: now,
          metrics: { cpu_pct: 20, uptime_s: 2 * 86_400 + 3600, disks: [{ path: 'C:', free_mb: 5000, total_mb: 9000 }] },
        }),
        node('PC1-scan', 2, { machine: 'PC1' }),
      ],
      total: 2,
      page: 1,
      pageSize: 200,
    });
    renderPage();
    const links = await screen.findAllByText('PC1');
    fireEvent.click(links[0]!);
    await waitFor(() => expect(getMachineMetrics).toHaveBeenCalledWith('PC1', '1h'));
    expect(await screen.findByText('Máy PC1')).toBeTruthy();
    expect(screen.getByText('2d 1h')).toBeTruthy();
    // Both workers of the machine are listed
    expect(screen.getAllByText('PC1-scan').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText('7 ngày'));
    await waitFor(() => expect(getMachineMetrics).toHaveBeenCalledWith('PC1', '7d'));
  }, 30_000);

  it('drawer máy: Lấy log của từng worker, liệt kê các lần xin và tải log đã có', async () => {
    const now = new Date().toISOString();
    getMachineMetrics.mockResolvedValue({ machine: 'PC1', range: '1h', bucket_seconds: 60, from: now, to: now, points: [] });
    listNodes.mockResolvedValue({ items: [node('PC1-render', 1, { machine: 'PC1' })], total: 1, page: 1, pageSize: 200 });
    listNodeLogs.mockResolvedValue({ items: [{ id: 'log-1', node_id: 'id-PC1-render', status: 'uploaded', since: null, until: null, requested_at: now, uploaded_at: now, size_bytes: 12 * 1024, error: null }] });
    requestNodeLogs.mockResolvedValue({});
    downloadNodeLog.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click((await screen.findAllByText('PC1'))[0]!);
    expect(await screen.findByText('Log của worker')).toBeTruthy();
    expect(await screen.findByText('12 KB')).toBeTruthy();
    expect(screen.getByText('Đã có')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Lấy log/ }));
    await waitFor(() => expect(requestNodeLogs).toHaveBeenCalledWith('id-PC1-render', { since: null, until: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Tải log' }));
    await waitFor(() => expect(downloadNodeLog).toHaveBeenCalledWith('id-PC1-render', 'log-1'));
  }, 30_000);
});
