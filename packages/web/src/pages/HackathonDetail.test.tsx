import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HackathonDetail from './HackathonDetail';

jest.mock('@/lib/api', () => ({
  hackathons: {
    get: jest.fn(),
    prediction: jest.fn(),
    activity: jest.fn(),
    claim: jest.fn(),
    enrich: jest.fn(),
    addNote: jest.fn(),
  },
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const hackathon = {
  id: 'h1',
  name: 'Smart India Hackathon',
  status: 'RECURRING_PATTERN',
  mode: 'offline',
  city: 'Delhi',
  state: 'Delhi',
  organizer_name: 'Ministry of Education',
  hackathon_url: 'https://sih.gov.in',
  source_platform: 'sih.gov.in',
  outreach_readiness: 'PARTIALLY_ENRICHED',
  confidence_score: 80,
  completeness_score: 65,
  verification_status: 'verified',
  source_count: 2,
  claimed_by: null,
  assigned_to: null,
};

const prediction = {
  id: 'p1',
  hackathon_id: 'h1',
  predicted_occurrence: '2027-03-15',
  expected_month: 3,
  expected_registration_window: 'January–February',
  confidence: 72,
  basis: 'Observed 3 occurrence(s): March 2024, March 2025, March 2026. Median interval 1 year(s); month consistency 100%.',
  evidence: [
    { year: 2024, month: 3, event_start: '2024-03-10', source_url: 'https://example.com/2024' },
    { year: 2025, month: 3, event_start: '2025-03-12', source_url: 'https://example.com/2025' },
    { year: 2026, month: 3, event_start: '2026-03-15', source_url: 'https://example.com/2026' },
  ],
  historical_observations: 3,
  method: 'historical_recurrence_analysis (month distribution + inter-year interval)',
  limitations: 'Based only on recorded historical occurrences.',
  status: 'PREDICTED',
  generated_at: '2026-09-20T02:30:00Z',
};

const renderDetail = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/hackathons/h1']}>
        <Routes>
          <Route path="/hackathons/:id" element={<HackathonDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Hackathon detail page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
    mockedApi.hackathons.get.mockResolvedValue({
      hackathon,
      occurrences: [
        { id: 'o1', year: 2024, event_start: '2024-03-10', city: 'Delhi', is_confirmed: true },
        { id: 'o2', year: 2025, event_start: '2025-03-12', city: 'Delhi', is_confirmed: true },
      ],
      contacts: [],
      sources: [{ id: 's1', source_platform: 'sih.gov.in', source_url: 'https://sih.gov.in', extraction_method: 'html', confidence: 0.9, fetched_at: '2026-09-20T00:00:00Z' }],
      predictions: [],
      activity: [],
      notes: [],
    });
    mockedApi.hackathons.activity.mockResolvedValue({ activity: [] });
  });

  it('shows a prediction as explicitly not confirmed, with its evidence and method', async () => {
    mockedApi.hackathons.prediction.mockResolvedValue({ prediction, available: true });

    renderDetail();

    await waitFor(() => expect(screen.getByText('PREDICTED — not confirmed')).toBeTruthy());
    expect(screen.getByText('72% confidence')).toBeTruthy();
    expect(screen.getByText(/Expected occurrence:/)).toBeTruthy();
    expect(screen.getByText(/Median interval 1 year/)).toBeTruthy();
    expect(screen.getByText(/historical_recurrence_analysis/)).toBeTruthy();
    expect(screen.getByText(/Limitations:/)).toBeTruthy();
    // The evidence list spells out each observed edition the prediction rests on.
    const card = screen.getByText('PREDICTED — not confirmed').closest('.card') as HTMLElement;
    expect(card.textContent).toContain('Evidence');
    expect(card.textContent).toContain('March 2024');
    expect(card.textContent).toContain('2024-03-10');
  });

  it('shows no prediction block at all when nothing was modelled', async () => {
    mockedApi.hackathons.prediction.mockResolvedValue({ prediction: null, available: false });

    renderDetail();

    await waitFor(() => expect(screen.getByText('Smart India Hackathon')).toBeTruthy());
    // Absence is the honest answer: no placeholder date, no invented confidence.
    expect(screen.queryByText('PREDICTED — not confirmed')).toBeNull();
  });

  it('keeps historical occurrences listed as confirmed facts', async () => {
    mockedApi.hackathons.prediction.mockResolvedValue({ prediction, available: true });

    renderDetail();

    await waitFor(() => expect(screen.getByText('2024')).toBeTruthy());
    expect(screen.getByText('2025')).toBeTruthy();
    expect(screen.getByText(/verification: verified/)).toBeTruthy();
  });
});
