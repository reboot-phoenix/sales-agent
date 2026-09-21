import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { CommandPalette } from './CommandPalette';

jest.mock('@/lib/api', () => ({
  searchAll: { query: jest.fn(), suggest: jest.fn() },
}));

jest.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(() => ({
    user: { id: '1', email: 'admin@test.com', role: 'admin' },
    logout: jest.fn(),
    revokeCurrentToken: jest.fn(),
  }), {}),
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderPalette = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const openPalette = () => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
};

describe('CommandPalette', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
    mockedApi.searchAll.query.mockResolvedValue({
      query: 'sma',
      counts: { jobs: 1, hackathons: 1, colleges: 1, organizations: 0 },
      results: {
        jobs: [{ id: 'j1', company_name: 'Smartworks', job_title: 'Junior Developer', city: 'Pune' }],
        hackathons: [{ id: 'h1', name: 'Smart India Hackathon', organizer_name: 'MoE', status: 'REGISTRATION_OPEN' }],
        colleges: [{ id: 'c1', name: 'SMART Institute of Technology', city: 'Chennai', state: 'Tamil Nadu' }],
        organizations: [],
      },
    });
  });

  it('lists every intelligence domain in navigation', async () => {
    renderPalette();
    openPalette();

    await waitFor(() => expect(screen.getByText('Hackathon Leads')).toBeTruthy());
    expect(screen.getByText('College Intelligence')).toBeTruthy();
    expect(screen.getByText('My Leads')).toBeTruthy();
    expect(screen.getByText('Scraper Armies')).toBeTruthy();
  });

  it('searches records across domains and keeps the groups separate', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search commands/i), { target: { value: 'sma' } });

    await waitFor(() => expect(screen.getByText('Smart India Hackathon')).toBeTruthy());
    expect(screen.getByText('Job leads')).toBeTruthy();
    expect(screen.getByText('Hackathons')).toBeTruthy();
    expect(screen.getByText('Colleges')).toBeTruthy();
    expect(screen.getByText('Smartworks')).toBeTruthy();
    expect(screen.getByText('SMART Institute of Technology')).toBeTruthy();
    // The search query is sent with the domain list, never unscoped.
    expect(mockedApi.searchAll.query).toHaveBeenCalledWith('sma', ['jobs', 'hackathons', 'colleges']);
  });

  it('does not query the search API for a single character', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search commands/i), { target: { value: 's' } });

    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApi.searchAll.query).not.toHaveBeenCalled();
  });

  it('still filters navigation commands as before', async () => {
    renderPalette();
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search commands/i), { target: { value: 'anal' } });

    await waitFor(() => expect(screen.getByText('Analytics')).toBeTruthy());
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it('says so plainly when nothing matches', async () => {
    mockedApi.searchAll.query.mockResolvedValue({ query: 'zzz', counts: {}, results: { jobs: [], hackathons: [], colleges: [], organizations: [] } });

    renderPalette();
    openPalette();
    fireEvent.change(screen.getByPlaceholderText(/Search commands/i), { target: { value: 'zzz' } });

    await waitFor(() => expect(screen.getByText('No results.')).toBeTruthy());
  });
});
