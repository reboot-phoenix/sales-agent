import axios from 'axios';
import { LoginResponse } from './types';
import { API_URL } from '@/lib/env';
import { navigateToLogin } from './navigation';

const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  // Send/receive the session cookies (refresh_token, sse_auth). Same-origin
  // requests already carry them; this covers a deployment that points
  // VITE_API_URL at another host with an explicit CORS origin.
  withCredentials: true,
});

let isRefreshing = false;
let refreshSubscribers: Array<{
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  retryRequest: (token: string) => Promise<unknown>;
}> = [];

const onRefreshed = (token: string) => {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  subs.forEach(({ resolve, retryRequest }) => {
    // Retry with the fresh token attached at dispatch time, so a second
    // rotation between queue and dispatch cannot replay the stale one.
    void Promise.resolve()
      .then(() => retryRequest(token))
      .then(resolve, resolve);
  });
};

// Refresh failed (expired cookie, revoked session): every queued request must
// reject — previously they hung forever because this list had no failure path.
const onRefreshFailed = (err: unknown) => {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  subs.forEach(({ reject }) => reject(err));
};

const addRefreshSubscriber = (sub: {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  retryRequest: (token: string) => Promise<unknown>;
}) => {
  refreshSubscribers.push(sub);
};

// Auth endpoints must never go through the refresh path. A 401 from /auth/refresh
// that re-enters this interceptor would queue itself behind the very lock it is
// holding, so the leader's `finally` never runs and every request stalls forever.
const AUTH_FREE_URLS = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !AUTH_FREE_URLS.some((u) => (originalRequest.url || '').startsWith(u))
    ) {
      originalRequest._retry = true;

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          addRefreshSubscriber({
            resolve,
            reject,
            retryRequest: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              return api(originalRequest);
            },
          });
        });
      }

      isRefreshing = true;

      try {
        const mod = await import('@/stores/auth');
        // refreshSession() exchanges the HttpOnly refresh cookie for a new access
        // token. The store used to hold the refresh token and post it in the body;
        // nothing durable now lives in JS, so a 401 can only be resolved by the
        // browser presenting its own cookie. It returns false instead of throwing
        // so this interceptor owns the failure path (clear + redirect) once.
        const refreshed = await mod.useAuthStore.getState().refreshSession();
        const newToken = mod.useAuthStore.getState().token;
        if (!refreshed || !newToken) {
          throw new Error('Session expired');
        }

        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        onRefreshed(newToken);

        return api(originalRequest);
      } catch (refreshError) {
        const { useAuthStore } = await import('@/stores/auth');
        // Queued requests must reject: without this they hung forever on a
        // failed refresh (expired cookie / revoked session).
        onRefreshFailed(refreshError);
        // Drop credentials first so nothing in flight can replay the dead token,
        // then hand off to the login route.
        useAuthStore.getState().logout();
        navigateToLogin();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    const message =
      error.response?.data?.error ||
      error.message ||
      'An unexpected error occurred';
    return Promise.reject(new Error(message));
  },
);

export const auth = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    const res = await api.post('/auth/login', { email, password });
    return res.data;
  },
  register: async (email: string, password: string) => {
    const res = await api.post('/auth/register', { email, password });
    return res.data;
  },
  logout: async () => {
    await api.post('/auth/logout');
  },
};

export interface ImportResult {
  total_rows: number;
  created: number;
  merged: number;
  merged_fuzzy: number;
  skipped: number;
  columns_mapped: Record<string, string>;
  columns_ignored: string[];
  errors: Array<{ row: number; reason: string }>;
}

export const leads = {
  list: async (params?: Record<string, any>) => {
    const res = await api.get('/leads', { params });
    return res.data;
  },
  // Server-side export: every lead matching the filters, as a styled workbook.
  // responseType blob so axios does not try to parse the XML payload.
  // format=csv returns the identical column set as plain CSV.
  exportExcel: async (params?: Record<string, any>) => {
    const res = await api.get('/leads/export', { params, responseType: 'blob' });
    return res.data as Blob;
  },
  // CSV/TSV import. The file is parsed in the browser and posted as text; the server
  // maps headers and dedups, so nothing new has to be installed for multipart.
  importCsv: async (payload: { csv?: string; rows?: Array<Record<string, string>>; dry_run?: boolean }) => {
    // A chunk of a few thousand rows is tens of MB through JSON; the client default would
    // abort mid-upload. The server rejects an oversized body with 413 well before this.
    const res = await api.post('/leads/import', payload, {
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return res.data as ImportResult;
  },
  get: async (id: string) => {
    const res = await api.get(`/leads/${id}`);
    return res.data;
  },
  enrich: async (id: string, provider?: string) => {
    const res = await api.post(`/leads/${id}/enrich`, { provider });
    return res.data;
  },
  verify: async (id: string) => {
    const res = await api.post(`/leads/${id}/verify`);
    return res.data;
  },
  draft: async (id: string, channel: 'email' | 'whatsapp' | 'both' = 'both') => {
    const res = await api.post(`/leads/${id}/draft`, { channel });
    return res.data;
  },
  editDraft: async (leadId: string, draftId: string, data: { subject?: string; body?: string }) => {
    const res = await api.patch(`/leads/${leadId}/draft/${draftId}`, data);
    return res.data;
  },
  send: async (id: string, channel: 'email' | 'whatsapp' | 'both' = 'both', draftId?: string) => {
    const res = await api.post(`/leads/${id}/send`, { channel, draft_id: draftId });
    return res.data;
  },
  verifyAndSend: async (id: string, channel: 'email' | 'whatsapp' | 'both' = 'both', draftId?: string) => {
    const res = await api.post(`/leads/${id}/verify-and-send`, { channel, draft_id: draftId });
    return res.data;
  },
  scoreExplanation: async (id: string) => {
    const res = await api.get(`/leads/${id}/score`);
    return res.data as {
      score: number;
      band: string;
      breakdown: Record<string, { points: number; reason: string } | undefined>;
    };
  },
  timeline: async (id: string) => {
    const res = await api.get(`/leads/${id}/timeline`);
    return res.data;
  },
  bulkDraft: async (leadIds: string[], channel: 'email' | 'whatsapp' | 'both' = 'both') => {
    const res = await api.post('/leads/bulk-draft', { lead_ids: leadIds, channel });
    return res.data;
  },
  bulkClaim: async (leadIds: string[]) => {
    const res = await api.post('/leads/bulk-claim', { lead_ids: leadIds });
    return res.data as { claimed: string[]; already_claimed: Array<{ id: string; claimed_by_email: string | null }> };
  },
  bulkAssign: async (leadIds: string[], assignedTo: string | null) => {
    const res = await api.patch('/leads/bulk-assign', { lead_ids: leadIds, assigned_to: assignedTo });
    return res.data as { assigned: string[]; assigned_to: string | null };
  },
  setDoNotContact: async (id: string, doNotContact: boolean) => {
    const res = await api.patch(`/leads/${id}/do-not-contact`, { do_not_contact: doNotContact });
    return res.data;
  },
  assign: async (id: string, assignedTo: string | null) => {
    const res = await api.patch(`/leads/${id}/assign`, { assigned_to: assignedTo });
    return res.data;
  },
  claim: async (id: string) => {
    const res = await api.post(`/leads/${id}/claim`, {});
    return res.data;
  },
  ownership: async (id: string) => {
    const res = await api.get(`/leads/${id}/ownership`);
    return res.data;
  },
  my: async (params?: Record<string, any>) => {
    const res = await api.get('/leads/my', { params });
    return res.data;
  },
  mine: async (params?: Record<string, any>) => {
    const res = await api.get('/leads', { params: { ...params, mine: true } });
    return res.data;
  },
  enrichment: async (id: string) => {
    const res = await api.get(`/leads/${id}/enrichment`);
    return res.data as { jobs: any[]; log: any[] };
  },
  enrichmentJob: async (jobId: string) => {
    const res = await api.get(`/leads/enrichment/jobs/${jobId}`);
    return res.data;
  },
  getDuplicates: async () => {
    const res = await api.get('/leads/duplicates');
    return res.data;
  },
  mergeDuplicate: async (id: string, mergeIntoId: string) => {
    const res = await api.post(`/leads/${id}/merge-duplicate`, { merge_into_id: mergeIntoId });
    return res.data;
  },
};

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  about: string | null;
  industry: string | null;
  size_estimate: string | null;
  default_email: string | null;
  default_phone: string | null;
  website_url: string | null;
  created_at: string;
  updated_at: string;
  lead_count?: number;
}

export interface HRContact {
  id: string;
  full_name: string | null;
  linkedin_url: string | null;
  personal_email: string | null;
  personal_mobile: string | null;
  current_company_id: string | null;
  confidence_score: number;
  created_at: string;
  updated_at: string;
  company_name?: string;
}

export const companies = {
  list: async (params?: Record<string, any>) => {
    const res = await api.get('/companies', { params });
    return res.data;
  },
  get: async (id: string) => {
    const res = await api.get(`/companies/${id}`);
    return res.data;
  },
  create: async (data: Partial<Company>) => {
    const res = await api.post('/companies', data);
    return res.data;
  },
  update: async (id: string, data: Partial<Company>) => {
    const res = await api.patch(`/companies/${id}`, data);
    return res.data;
  },
  remove: async (id: string) => {
    const res = await api.delete(`/companies/${id}`);
    return res.data;
  },
};

export const contacts = {
  list: async (params?: Record<string, any>) => {
    const res = await api.get('/contacts', { params });
    return res.data;
  },
  get: async (id: string) => {
    const res = await api.get(`/contacts/${id}`);
    return res.data;
  },
  create: async (data: Partial<HRContact>) => {
    const res = await api.post('/contacts', data);
    return res.data;
  },
  update: async (id: string, data: Partial<HRContact>) => {
    const res = await api.patch(`/contacts/${id}`, data);
    return res.data;
  },
  remove: async (id: string) => {
    const res = await api.delete(`/contacts/${id}`);
    return res.data;
  },
};

export interface CreditUsageResponse {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  by_provider: Record<string, { used: number; limit: number }>;
  period_start: string;
  period_end: string;
}

export interface RunLog {
  id: string;
  started_at: string;
  finished_at: string | null;
  sources_attempted: number;
  sources_succeeded: number;
  sources_circuit_broken: string[];
  leads_found: number;
  leads_deduped: number;
  errors: any;
}

export const dashboard = {
  stats: async () => {
    const res = await api.get('/dashboard/stats');
    return res.data;
  },
  credits: async () => {
    const res = await api.get('/dashboard/credits');
    return res.data as CreditUsageResponse;
  },
};

export const admin = {
  triggerRun: async (sources?: string[]) => {
    const res = await api.post('/runs/trigger', { sources });
    return res.data;
  },
  runArmy: async () => {
    const res = await api.post('/runs/army', {});
    return res.data;
  },
  armyStatus: async () => {
    const res = await api.get('/army/status');
    return res.data as { raw: number; enrichment: number; verification: number; draft: number; scrape?: number; halted?: boolean };
  },
  stopArmy: async () => {
    const res = await api.post('/runs/army/stop', {});
    return res.data as { stopped: boolean; reason?: string; cleared_queued_jobs?: number; queues?: Record<string, number> };
  },
  getRun: async (id: string) => {
    const res = await api.get(`/runs/${id}`);
    return res.data;
  },
  getRuns: async (limit = 10) => {
    const res = await api.get('/runs', { params: { limit } });
    return res.data;
  },
  updateApiKeys: async (keys: Record<string, string>) => {
    const res = await api.put('/settings/api-keys', { api_keys: keys });
    return res.data;
  },
  getApiKeys: async () => {
    const res = await api.get('/settings/api-keys');
    return res.data;
  },
  getSetting: async (key: string) => {
    const res = await api.get(`/settings/${key}`);
    return res.data;
  },
  updateSettings: async (settings: Record<string, any>) => {
    const res = await api.put('/settings', settings);
    return res.data;
  },
  sourceHealth: async () => {
    const res = await api.get('/sources/health');
    return res.data;
  },
  providerStatus: async () => {
    const res = await api.get('/providers/status');
    return res.data as {
      enrichment: Record<string, boolean>;
      sending: { email: boolean; whatsapp: boolean };
      ai: { gemini: boolean };
    };
  },
  bulkDraftEnrich: async (leadIds: string[], channel: 'email' | 'whatsapp' | 'both' = 'both') => {
    const res = await api.post('/leads/bulk-draft', { lead_ids: leadIds, channel });
    return res.data;
  },
  getUsers: async () => {
    const res = await api.get('/users');
    return res.data;
  },
  teamMembers: async () => {
    const res = await api.get('/team/members');
    return res.data as { members: Array<{ id: string; email: string; role: string }> };
  },
  enrichmentOrder: async () => {
    const res = await api.get('/enrichment/order');
    return res.data as { order: string[] };
  },
};

export const health = {
  check: async () => {
    const res = await api.get('/health');
    return res.data;
  },
};

export default api;
