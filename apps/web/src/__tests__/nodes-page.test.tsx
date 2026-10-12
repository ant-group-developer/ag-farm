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
vi.mock('../api/admin', () => ({
  listNodes: (...args: unknown[]) => listNodes(...args),
  createNode: vi.fn(),
  patchNode: (...args: unknown[]) => patchNode(...args),
  deleteNode: vi.fn(),
  reorderNodes: vi.fn(),
  createEnrollment: vi.fn(),
  requestNodeUpdate: (...args: unknown[]) => requestNodeUpdate(...args),
  getLatestReleases: (...args: unknown[]) => getLatestReleases(...args),
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
});
