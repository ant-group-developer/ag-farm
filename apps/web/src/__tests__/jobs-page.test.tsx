import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n/config';
import type { JobView, OwnerView } from '../types/api';

const listJobs = vi.fn();
const listOwners = vi.fn();
const getJob = vi.fn();
vi.mock('../api/admin', () => ({
  listJobs: (...args: unknown[]) => listJobs(...args),
  listOwners: (...args: unknown[]) => listOwners(...args),
  getJob: (...args: unknown[]) => getJob(...args),
  cancelJob: vi.fn(),
  cancelJobs: vi.fn(),
  pauseJobs: vi.fn(),
  resumeJobs: vi.fn(),
  retryJob: vi.fn(),
}));

const { JobsPage } = await import('../modules/jobs/JobsPage');

const ASSET = '3f2b8c1e-0000-4000-8000-000000000001';

const scanJob: JobView = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  owner: 'ag-go',
  type: 'scan.extract',
  lane: 'batch',
  status: 'completed',
  priority: 0,
  correlation_id: 'c',
  affinity_key: null,
  group_key: null,
  attempt_count: 1,
  max_attempts: 3,
  node_id: null,
  progress_percent: 100,
  progress_stage: null,
  result: null,
  error: null,
  created_at: '2026-10-28T10:00:00.000Z',
  updated_at: '2026-10-28T10:03:35.000Z',
  started_at: '2026-10-28T10:00:30.000Z',
  finished_at: '2026-10-28T10:03:35.000Z',
  acked_at: null,
  payload: { asset: { id: ASSET, kind: 'video' } },
};

const renderJob: JobView = {
  ...scanJob,
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  owner: 'studio',
  type: 'studio.render_final',
  payload: { production_id: 'p42', revision: 7, output: 'videos/v9/final/bbbbbbbb.mp4' },
};

const owners: OwnerView[] = [
  {
    id: 'ag-go',
    sign_url: 'https://go/farm/sign',
    allowed_types: ['scan.extract'],
    web_url: 'https://go.example.com',
    created_at: scanJob.created_at,
    updated_at: scanJob.created_at,
  },
  {
    id: 'studio',
    sign_url: 'https://studio/farm/sign',
    allowed_types: ['studio.render_final'],
    web_url: 'https://studio.example.com',
    created_at: scanJob.created_at,
    updated_at: scanJob.created_at,
  },
];

beforeAll(async () => {
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

describe('JobsPage', () => {
  it('hiện thời gian chạy, video của job và link mở ở ứng dụng', async () => {
    listJobs.mockResolvedValue({ items: [scanJob, renderJob], total: 2, page: 1, pageSize: 20 });
    listOwners.mockResolvedValue({ items: owners, total: 2, page: 1, pageSize: 200 });
    getJob.mockResolvedValue(scanJob);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NuqsTestingAdapter>
        <QueryClientProvider client={qc}>
          <JobsPage />
        </QueryClientProvider>
      </NuqsTestingAdapter>,
    );

    const renderLink = await screen.findByRole('link', { name: /Dự án p42 · bản 7/ });
    expect(renderLink.getAttribute('href')).toBe('https://studio.example.com/p/p42/v/v9?tab=preview');
    expect(renderLink.getAttribute('target')).toBe('_blank');
    const scanLink = screen.getByRole('link', { name: /Video 3f2b8c1e…/ });
    expect(scanLink.getAttribute('href')).toBe(`https://go.example.com/footage?asset=${ASSET}`);
    expect(screen.getAllByText('3:05')).toHaveLength(2);

    fireEvent.click(screen.getAllByText(/^aaaaaaaa…$/)[0]!);
    await waitFor(() => expect(screen.getByText('Chờ trong hàng đợi')).toBeTruthy());
    expect(screen.getByText('0:30')).toBeTruthy();
    // Drawer ghi id đầy đủ của video dưới link.
    expect(screen.getByText(ASSET)).toBeTruthy();
  });
});
