import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from 'react-query';
import DomainInsights, { DistributionList } from './DomainInsights';

jest.mock('@/lib/api', () => ({
  analyticsDomains: {
    jobs: jest.fn(),
    hackathons: jest.fn(),
    colleges: jest.fn(),
    scraper: jest.fn(),
  },
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderPanel = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DomainInsights />
    </QueryClientProvider>,
  );

describe('DomainInsights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
  });

  it('shows hackathon analytics with predictions separated from confirmed events', async () => {
    mockedApi.analyticsDomains.hackathons.mockResolvedValue({
      measured: true,
      total: 120,
      historical: 60,
      predicted: 7,
      recurring: 9,
      registration_open: 12,
      organizers: 40,
      average_prize_pool: 250000,
      pending_raw: 0,
      by_state: [{ value: 'Karnataka', count: 30 }],
      by_month: [{ month: 3, count: 18 }],
      by_technology: [{ value: 'AI', count: 22 }],
      recurring_organizers: [{ value: 'Acme', count: 3 }],
      prize_buckets: [{ bucket: 'above_5L', count: 4 }],
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText('120')).toBeTruthy());
    expect(screen.getByText('Predicted')).toBeTruthy();
    expect(screen.getByText('modelled, not confirmed')).toBeTruthy();
    expect(screen.getByText('Mar')).toBeTruthy(); // month index -> name, not a raw number
    expect(screen.getByText('Karnataka')).toBeTruthy();
  });

  it('reports zero for a domain with no data instead of inventing a distribution', async () => {
    mockedApi.analyticsDomains.hackathons.mockResolvedValue({
      measured: true, total: 0, historical: 0, predicted: 0, recurring: 0,
      registration_open: 0, organizers: 0, average_prize_pool: null, pending_raw: 0,
      by_state: [], by_month: [], by_technology: [], recurring_organizers: [], prize_buckets: [],
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText('No state data yet.')).toBeTruthy());
    expect(screen.getByText('No dated events yet.')).toBeTruthy();
    expect(screen.getByText('Avg prize')).toBeTruthy();
  });

  it('surfaces raw records still awaiting processing (no silent lead loss)', async () => {
    mockedApi.analyticsDomains.hackathons.mockResolvedValue({
      measured: true, total: 5, historical: 0, predicted: 0, recurring: 0,
      registration_open: 0, organizers: 0, average_prize_pool: null, pending_raw: 42,
      by_state: [], by_month: [], by_technology: [], recurring_organizers: [], prize_buckets: [],
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText(/42 raw discovery record/)).toBeTruthy());
    expect(screen.getByText(/none have been dropped/)).toBeTruthy();
  });

  it('switching tabs queries that domain only', async () => {
    mockedApi.analyticsDomains.hackathons.mockResolvedValue({ measured: true, total: 0, by_state: [], by_month: [], by_technology: [], recurring_organizers: [], prize_buckets: [], pending_raw: 0 });
    mockedApi.analyticsDomains.colleges.mockResolvedValue({
      measured: true, total: 500, states_covered: 20, districts_covered: 180, with_website: 300,
      enriched: 120, contacts_total: 700, tpo_roles: 210, principals: 150, contact_emails: 400,
      contact_phones: 120, pending_raw: 0, by_state: [], by_ownership: [], by_outreach_readiness: [],
      by_enrichment_status: [], by_source: [],
    });

    renderPanel();
    await waitFor(() => expect(mockedApi.analyticsDomains.hackathons).toHaveBeenCalled());

    fireEvent.click(screen.getByText('Colleges'));

    await waitFor(() => expect(mockedApi.analyticsDomains.colleges).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('TPO contacts')).toBeTruthy());
    expect(screen.getByText('210')).toBeTruthy();
  });

  it('shows scraper fleet health and honours the enabled flag from the API', async () => {
    mockedApi.analyticsDomains.hackathons.mockResolvedValue({ measured: true, total: 0, by_state: [], by_month: [], by_technology: [], recurring_organizers: [], prize_buckets: [], pending_raw: 0 });
    mockedApi.analyticsDomains.scraper.mockResolvedValue({
      measured: true, total_runs: 30, successful_runs: 27, failed_runs: 3, running_runs: 1,
      records_discovered: 5000, duplicates_removed: 400, contacts_discovered: 600,
      enrichments_done: 300, predictions_generated: 12, errors: 9, retries: 14,
      by_domain: [{ value: 'hackathons', count: 10 }], recent_runs: [],
      source_health: [{ domain: 'colleges', name: 'aicte', health_status: 'SOURCE_TEMPORARILY_UNAVAILABLE', consecutive_failures: 3 }],
      recent_errors: [{ domain: 'colleges', source: 'aicte', error: 'timeout after 10s' }],
      raw_pending: [{ value: 'colleges', count: 25 }],
    });

    renderPanel();
    fireEvent.click(screen.getByText('Scraper fleet'));

    await waitFor(() => expect(screen.getByText(/colleges\/aicte · SOURCE_TEMPORARILY_UNAVAILABLE/)).toBeTruthy());
    expect(screen.getByText('timeout after 10s')).toBeTruthy();
    expect(screen.getByText(/25/)).toBeTruthy();
  });
});

describe('DistributionList', () => {
  it('renders counts formatted for Indian numbering and keeps zeros visible', () => {
    render(
      <DistributionList
        title="By state"
        items={[{ label: 'Karnataka', value: 12000 }, { label: 'Goa', value: 0 }]}
        emptyLabel="No state data yet."
      />,
    );

    expect(screen.getByText('12,000')).toBeTruthy();
    expect(screen.getByText('Goa')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('says so plainly when a distribution is empty', () => {
    render(<DistributionList title="By state" items={[]} emptyLabel="No state data yet." />);
    expect(screen.getByText('No state data yet.')).toBeTruthy();
  });
});
