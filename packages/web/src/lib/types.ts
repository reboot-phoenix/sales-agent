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
}

export type PipelineStage =
  | 'discovered'
  | 'enriched'
  | 'verified'
  | 'drafted'
  | 'contacted'
  | 'replied'
  | 'bounced'
  | 'contact_unavailable'
  | 'suppressed'
  | 'send_failed'
  | 'provider_error'
  | 'retry_pending';

export type ScoreBand = 'hot' | 'warm' | 'cold';
export type DataQuality = 'complete' | 'incomplete';
export type EmailStatus = 'valid' | 'invalid' | 'catch_all' | 'disposable' | 'unknown' | 'expired' | null;
export type WhatsAppStatus = 'registered' | 'not_registered' | 'unknown' | 'expired' | null;

export interface Lead {
  id: string;
  job_posting_id: string;
  company_id: string;
  hr_contact_id: string | null;
  lead_score: number;
  score_band: ScoreBand;
  pipeline_stage: PipelineStage;
  data_quality: DataQuality;
  email_status: EmailStatus;
  whatsapp_status: WhatsAppStatus;
  do_not_contact: boolean;
  possible_duplicate_of: string | null;
  assigned_to: string | null;
  assigned_to_email?: string | null;
  claimed_by?: string | null;
  claimed_by_email?: string | null;
  claimed_at?: string | null;
  created_at: string;
  updated_at: string;
  hr_extraction_provenance?: any;
  enrichment_provenance?: any;

  company_name: string;
  company_domain: string | null;
  job_title: string | null;
  hr_name: string | null;
  hr_linkedin_url: string | null;
  hr_email: string | null;
  hr_mobile: string | null;
  hr_title?: string | null;
  hr_department?: string | null;
  hr_seniority?: string | null;
  hr_location?: string | null;
  hr_emails?: string[] | null;
  hr_phones?: string[] | null;
  hr_email_verified?: boolean | null;
  employee_count?: number | null;
  revenue?: string | null;
  founded_year?: number | null;
  source_site: string | null;
  confidence_score?: number;
  contact_source?: string;
  contact_method?: string;
  contact_url?: string;
  job_description: string | null;
  experience_level: string | null;
  salary_range: string | null;
  job_url: string | null;

  // Posting facets. The API now returns these; they were absent from the model,
  // so the UI had no way to show where a job is, what it pays, or when it was
  // posted even though the scraper had captured some of it.
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  location_type?: 'remote' | 'onsite' | 'hybrid' | null;
  employment_type?: string | null;
  is_work_from_home?: boolean | null;
  apply_url?: string | null;
  posted_at?: string | null;
  about_job?: string | null;
  department?: string | null;
  openings_count?: number | null;
  salary_min?: number | string | null;
  salary_max?: number | string | null;
  salary_currency?: string | null;
  salary_period?: string | null;
}

export interface LeadDetail extends Lead {
  about_company: string | null;
  about_job: string | null;
  industry: string | null;
  size_estimate: string | null;
  website_url: string | null;
  default_email: string | null;
  default_phone: string | null;
  legal_basis: string | null;
  processing_purpose: string | null;
  possible_duplicate_of: string | null;
  job_posting_id: string | null;
  company_id: string | null;
  hr_contact_id: string | null;
  hr_confidence: number | null;
  domain: string | null;
  hr_extraction_provenance?: any;
  enrichment_log: EnrichmentLog[];
  verification_log: VerificationLog[];
  drafts: OutreachDraft[];
  outreach_log: OutreachLog[];
}


export interface EnrichmentLog {
  id: string;
  lead_id: string;
  provider: string;
  requested_by: string | null;
  request_payload: any;
  response_payload: any;
  credits_used: number;
  status: 'success' | 'failed' | 'no_match';
  created_at: string;
}

export interface VerificationLog {
  id: string;
  lead_id: string;
  channel: 'email' | 'whatsapp';
  result: string;
  raw_response: any;
  created_at: string;
}

export interface OutreachDraft {
  id: string;
  lead_id: string;
  channel: 'email' | 'whatsapp';
  version: number;
  subject: string | null;
  body: string;
  generated_by: string;
  is_edited: boolean;
  created_at: string;
}

export interface OutreachLog {
  id: string;
  lead_id: string;
  draft_id: string | null;
  channel: 'email' | 'whatsapp';
  sent_by: string | null;
  provider_message_id: string | null;
  delivery_status: 'sent' | 'delivered' | 'bounced' | 'replied' | 'failed';
  sent_at: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

// ----------------------------------------------------------------------------
// Intelligence domains: hackathons, colleges, armies.
// These are deliberately separate from Lead — the schemas and workflows differ.
// ----------------------------------------------------------------------------

export type HackathonStatus =
  | 'DISCOVERED' | 'CONFIRMED' | 'ANNOUNCED' | 'REGISTRATION_OPEN' | 'UPCOMING'
  | 'HISTORICAL' | 'RECURRING_PATTERN' | 'PREDICTED' | 'LOW_CONFIDENCE_PREDICTION';

export type OutreachReadiness =
  | 'OUTREACH_READY' | 'PARTIALLY_ENRICHED' | 'NEEDS_ENRICHMENT' | 'INSUFFICIENT_DATA';

export interface Hackathon {
  id: string;
  name: string;
  slug: string;
  organizer_id: string | null;
  organizer_name: string | null;
  organizer_type: string | null;
  organization_description: string | null;
  organizer_website: string | null;
  hackathon_url: string | null;
  registration_url: string | null;
  source_url: string | null;
  source_platform: string | null;
  event_type: string | null;
  hackathon_type: string | null;
  mode: 'online' | 'offline' | 'hybrid' | null;
  venue: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  timezone: string | null;
  registration_start: string | null;
  registration_deadline: string | null;
  event_start: string | null;
  event_end: string | null;
  result_date: string | null;
  team_size_min: number | null;
  team_size_max: number | null;
  eligibility: string | null;
  student_only: boolean | null;
  college_only: boolean | null;
  open_to_public: boolean | null;
  technology: string | null;
  domain: string | null;
  tracks: string[];
  problem_statements: string[];
  themes: string[];
  tags: string[];
  required_skills: string[];
  preferred_skills: string[];
  prize_pool: number | string | null;
  first_prize: number | null;
  second_prize: number | null;
  third_prize: number | null;
  internship_opportunities: boolean | null;
  hiring_opportunities: boolean | null;
  certificates: boolean | null;
  mentorship: boolean | null;
  judging_criteria: string | null;
  organizer_email: string | null;
  organizer_phone: string | null;
  organizer_linkedin: string | null;
  organizer_instagram: string | null;
  organizer_x: string | null;
  organizer_facebook: string | null;
  organizer_discord: string | null;
  organizer_community: string | null;
  organizer_contact_name: string | null;
  organizer_contact_designation: string | null;
  contact_name: string | null;
  contact_designation: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_linkedin: string | null;
  contact_source: string | null;
  outreach_priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | null;
  outreach_status: string;
  verification_status: string;
  verification_grade: string | null;
  source_count: number;
  source_urls: string[];
  last_verified_at: string | null;
  freshness_score: number | null;
  confidence_score: number;
  status: HackathonStatus;
  historical_occurrence: boolean;
  occurrence_type: string;
  recurrence_pattern: string | null;
  predicted_occurrence: string | null;
  prediction_confidence: number | null;
  prediction_basis: string | null;
  historical_years: number[];
  expected_month: number | null;
  expected_registration_window: string | null;
  prediction_generated_at: string | null;
  completeness_score: number;
  freshness_category: string;
  enrichment_status: string;
  outreach_readiness: OutreachReadiness;
  claimed_by: string | null;
  claimed_at: string | null;
  assigned_to: string | null;
  claimed_by_email?: string | null;
  assigned_to_email?: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface HackathonOccurrence {
  id: string;
  hackathon_id: string;
  year: number;
  edition: string | null;
  event_start: string | null;
  event_end: string | null;
  registration_start: string | null;
  registration_deadline: string | null;
  venue: string | null;
  city: string | null;
  state: string | null;
  mode: string | null;
  prize_pool: number | string | null;
  source_url: string | null;
  source_platform: string | null;
  is_confirmed: boolean;
}

export interface HackathonPrediction {
  id: string;
  hackathon_id: string;
  predicted_occurrence: string | null;
  expected_month: number | null;
  expected_registration_window: string | null;
  confidence: number;
  basis: string;
  evidence: Array<{ year: number; month: number | null; event_start: string | null; source_url: string | null }>;
  historical_observations: number;
  method: string;
  limitations: string | null;
  status: 'PREDICTED' | 'LOW_CONFIDENCE_PREDICTION' | 'RECURRING_PATTERN';
  generated_at: string;
}

export interface DomainContact {
  id: string;
  full_name: string | null;
  designation: string | null;
  role_category: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  verification_status: string;
  contact_source: string | null;
  source_url?: string | null;
  confidence_score: number;
}

export interface College {
  id: string;
  name: string;
  official_name: string | null;
  slug: string;
  aishe_code: string | null;
  university_affiliation: string | null;
  state: string | null;
  district: string | null;
  city: string | null;
  address: string | null;
  pincode: string | null;
  institution_type: string | null;
  ownership: string | null;
  is_public: boolean | null;
  autonomous: boolean | null;
  accreditation: string | null;
  naac_grade: string | null;
  naac_score: number | string | null;
  nirf_rank: number | null;
  aicte_approved: boolean | null;
  website_url: string | null;
  official_email: string | null;
  phone: string | null;
  admissions_contact: string | null;
  placement_contact: string | null;
  tpo_name: string | null;
  tpo_email: string | null;
  tpo_phone: string | null;
  placement_head_name: string | null;
  principal_name: string | null;
  director_name: string | null;
  dean_name: string | null;
  hod: Array<{ name?: string; department?: string }>;
  linkedin_url: string | null;
  socials: Record<string, string>;
  programs: string[];
  verification_status: string;
  verification_grade: string | null;
  source_count: number;
  source_urls: string[];
  last_verified_at: string | null;
  freshness_score: number | null;
  confidence_score: number;
  contact_coverage: {
    contacts?: number;
    emails?: number;
    phones?: number;
    linkedin?: number;
    verified?: number;
    by_role?: Record<string, number>;
    best_priority?: string | null;
  };
  completeness_score: number;
  freshness_category: string;
  enrichment_status: string;
  outreach_readiness: OutreachReadiness;
  claimed_by: string | null;
  claimed_at: string | null;
  assigned_to: string | null;
  claimed_by_email?: string | null;
  assigned_to_email?: string | null;
  contacts_count?: number;
  tpo_contact_count?: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface ArmyRun {
  id: string;
  domain: 'jobs' | 'hackathons' | 'colleges';
  run_type: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';
  started_at: string;
  finished_at: string | null;
  sources_attempted: number;
  sources_succeeded: number;
  records_discovered: number;
  records_inserted: number;
  records_updated: number;
  duplicates_removed: number;
  contacts_discovered: number;
  enrichments_done: number;
  predictions_generated: number;
  errors_count: number;
  retries: number;
  checkpoint: Record<string, unknown>;
  worker_status: Array<Record<string, unknown>>;
  error: Record<string, unknown> | null;
}

export interface ArmySource {
  id: string;
  domain: string;
  name: string;
  adapter: string;
  tier: number;
  enabled: boolean;
  health_status: string;
  last_run_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  last_error: string | null;
}

export interface User {
  id: string;
  email: string;
  role: 'admin' | 'sales_rep' | 'viewer';
}

export interface LoginResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  user: { id: string; email: string; role: string };
}
