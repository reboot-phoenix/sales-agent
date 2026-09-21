import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import Armies from './Armies';

jest.mock('@/lib/api', () => ({
  armies: {
    runs: jest.fn(),
    sources: jest.fn(),
    run: jest.fn(),
    runAll: jest.fn(),
    runDetail: jest.fn(),
  },
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const run = {
  id: 'run-1',
  domain: 'hackathons',
  run_type: 'manual',
  status: 'running',
  started_at: '2026-09-20T02:00:00Z',
  finished_at: null,
  sources_attempted: 6,
  sources_succeeded: 5,
  records_discovered: 120,
  records_inserted: 80,
  records_updated: 30,
  duplicates_removed: 10,
  contacts_discovered: 14,
  enrichments_done: 9,
  predictions_generated: 3,
  errors_count: 1,
  retries: 2,
  checkpoint: {},
  worker_status: [],
  error: null,
};

const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Armies />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Armies page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
    mockedApi.armies.runs.mockResolvedValue({ runs: [run] });
    mockedApi.armies.sources.mockResolvedValue({ sources: [] });
  });

  it('offers one run button per army plus a concurrent run-all', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('Run Job Army')).toBeTruthy());
    expect(screen.getByText('Run Hackathon Army')).toBeTruthy();
    expect(screen.getByText('Run College Army')).toBeTruthy();
    expect(screen.getByText('Run all three concurrently')).toBeTruthy();
    expect(screen.getByText(/02:00 local time/)).toBeTruthy();
  });

  it('queues the hackathon army without blocking the page', async () => {
    mockedApi.armies.run.mockResolvedValue({ run_id: 'run-9', domain: 'hackathons' });

    renderPage();
    await waitFor(() => expect(screen.getByText('Run Hackathon Army')).toBeTruthy());
    fireEvent.click(screen.getByText('Run Hackathon Army'));

    await waitFor(() => expect(mockedApi.armies.run).toHaveBeenCalledWith('hackathons'));
  });

  it('runs all three armies in one action', async () => {
    mockedApi.armies.runAll.mockResolvedValue({ run_ids: { jobs: 'a', hackathons: 'b', colleges: 'c' } });

    renderPage();
    await waitFor(() => expect(screen.getByText('Run all three concurrently')).toBeTruthy());
    fireEvent.click(screen.getByText('Run all three concurrently'));

    await waitFor(() => expect(mockedApi.armies.runAll).toHaveBeenCalled());
  });

  it('shows run progress including duplicates removed and contacts discovered', async () => {
    renderPage();

    // "Hackathon Army" is both a launcher card and a row label; scope to the row.
    await waitFor(() => expect(screen.getAllByText('Hackathon Army').length).toBeGreaterThan(1));
    const row = screen.getAllByText('Hackathon Army').map((n) => n.closest('tr')).find(Boolean) as HTMLElement;
    expect(within(row).getByText('running')).toBeTruthy();
    // sources_succeeded / sources_attempted
    expect(within(row).getByText('5/6')).toBeTruthy();
    // records_inserted / records_updated
    expect(within(row).getByText('80/30')).toBeTruthy();
    expect(within(row).getByText('14')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
  });

  it('renders a failed source as SOURCE TEMPORARILY UNAVAILABLE, not as a system failure', async () => {
    mockedApi.armies.sources.mockResolvedValue({
      sources: [
        {
          id: 's1',
          domain: 'colleges',
          name: 'aicte',
          adapter: 'aicte',
          tier: 1,
          enabled: true,
          health_status: 'SOURCE_TEMPORARILY_UNAVAILABLE',
          last_run_at: '2026-09-20T02:05:00Z',
          last_success_at: '2026-09-19T02:05:00Z',
          consecutive_failures: 3,
          last_error: 'timeout after 10s',
        },
        {
          id: 's2',
          domain: 'colleges',
          name: 'aishe',
          adapter: 'aishe',
          tier: 1,
          enabled: true,
          health_status: 'healthy',
          last_run_at: '2026-09-20T02:05:00Z',
          last_success_at: '2026-09-20T02:05:00Z',
          consecutive_failures: 0,
          last_error: null,
        },
      ],
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('SOURCE TEMPORARILY UNAVAILABLE')).toBeTruthy());
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText('timeout after 10s')).toBeTruthy();
  });
});
