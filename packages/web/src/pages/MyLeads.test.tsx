import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MyLeads from './MyLeads';

jest.mock('@/lib/api', () => ({
  leads: { mine: jest.fn(), enrich: jest.fn() },
  myLeadsDomains: {
    summary: jest.fn(),
    jobs: jest.fn(),
    hackathons: jest.fn(),
    colleges: jest.fn(),
  },
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MyLeads />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('My Leads page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
    mockedApi.myLeadsDomains.summary.mockResolvedValue({
      jobs: { total: 3, contacted: 1, new_leads: 2 },
      hackathons: { total: 2, ready: 1, predicted: 1 },
      colleges: { total: 4, ready: 2, needs_enrichment: 1 },
    });
    mockedApi.leads.mine.mockResolvedValue({
      data: [{
        id: 'l1',
        lead_score: 82,
        pipeline_stage: 'verified',
        company_name: 'Test Corp',
        job_title: 'Junior Developer',
        hr_name: 'Jane Doe',
        hr_email: 'jane@test.com',
        created_at: '2026-09-01T00:00:00Z',
        assigned_to_email: 'me@example.com',
      }],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });
    mockedApi.myLeadsDomains.hackathons.mockResolvedValue({
      data: [{
        id: 'h1',
        name: 'Smart India Hackathon',
        organizer_name: 'MoE',
        status: 'REGISTRATION_OPEN',
        event_start: '2026-12-01',
        registration_deadline: '2026-11-01',
        contact_email: 'sih@innovateindia.gov.in',
        claimed_by_email: 'me@example.com',
      }],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });
    mockedApi.myLeadsDomains.colleges.mockResolvedValue({
      data: [{
        id: 'c1',
        name: 'ABC Institute of Technology',
        city: 'Pune',
        state: 'Maharashtra',
        tpo_name: null,
        tpo_email: null,
        outreach_readiness: 'NEEDS_ENRICHMENT',
        contacts_count: 0,
        assigned_to_email: 'me@example.com',
      }],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });
  });

  it('separates the three domains into tabs rather than one generic list', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('Jobs')).toBeTruthy());
    expect(screen.getByText('Hackathons')).toBeTruthy();
    expect(screen.getByText('Colleges')).toBeTruthy();
  });

  it('uses the ownership-scoped endpoint for job leads', async () => {
    renderPage();

    await waitFor(() => expect(mockedApi.leads.mine).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Test Corp')).toBeTruthy());
    // A rep's workspace must never be filled from the unscoped lead list.
    expect((mockedApi.leads as any).list).toBeUndefined();
  });

  it('switching to Hackathons calls the hackathon section and shows the owner', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Hackathons')).toBeTruthy());

    fireEvent.click(screen.getByText('Hackathons'));

    await waitFor(() => expect(mockedApi.myLeadsDomains.hackathons).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Smart India Hackathon')).toBeTruthy());
    // Owner is shown as a short label, and only ever from the claim/assignment fields.
    expect(screen.getByText('Claimed by me')).toBeTruthy();
  });

  it('shows a college with no TPO as not-found rather than an empty contact', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Colleges')).toBeTruthy());

    fireEvent.click(screen.getByText('Colleges'));

    await waitFor(() => expect(screen.getByText('ABC Institute of Technology')).toBeTruthy());
    expect(screen.getByText('not found')).toBeTruthy();
    expect(screen.getByText('NEEDS ENRICHMENT')).toBeTruthy();
  });

  it('shows per-domain counts from the summary', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });
});
