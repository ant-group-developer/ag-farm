import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import type { NodeView } from '../types/api';

const listNodes = vi.fn();
vi.mock('../api/admin', () => ({
  listNodes: (...args: unknown[]) => listNodes(...args),
  createNode: vi.fn(),
  patchNode: vi.fn(),
  deleteNode: vi.fn(),
  reorderNodes: vi.fn(),
  createEnrollment: vi.fn(),
}));

const { NodesPage } = await import('../modules/nodes/NodesPage');

function node(name: string, priority_order: number, over: Partial<NodeView> = {}): NodeView {
  return {
    id: `id-${name}`,
    name,
    machine: 'PC',
    kinds: ['scan.extract'],
    allowed_kinds: null,
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
});
