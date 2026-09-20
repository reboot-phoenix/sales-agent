// PII masking for anything that reaches logs / audit rows / analytics.
// Mirrors packages/scrapers/scrapers/utils/redact.py so both stacks agree.
import crypto from 'crypto';

export function redactEmail(email: string | null | undefined): string {
  if (!email) return '<none>';
  const e = String(email).trim();
  if (!e.includes('@')) return (e[0] ?? '') + '***';
  const [local, ...rest] = e.split('@');
  const domain = rest.join('@');
  const head = local ? local[0] : '';
  const tld = domain.includes('.') ? domain.split('.').pop() : domain;
  return `${head || '***'}***@***.${tld}`;
}

export function redactPhone(phone: string | null | undefined): string {
  if (!phone) return '<none>';
  const s = String(phone).replace(/[^0-9+]/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  const plus = s.startsWith('+') ? '+' : '';
  return `${plus}***${digits.slice(-2)}`;
}

/**
 * Privacy-preserving IP token for rate-limit keys / audit / abuse detection.
 * HMAC-SHA256 with a server-side secret (never a plain unsalted hash — those are
 * reversible via rainbow tables for a 32-bit IPv4 space). The secret never leaves
 * the backend; the frontend must never see it. Retention: 90 days max.
 */
export function hashIp(ip: string | null | undefined, secret: string): string {
  if (!ip || !secret) return 'unknown';
  const norm = String(ip).trim().toLowerCase();
  if (!norm) return 'unknown';
  return (
    'ip_' +
    crypto.createHmac('sha256', secret).update(norm).digest('hex').slice(0, 32)
  );
}
