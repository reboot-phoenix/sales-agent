import { z } from 'zod';
import { config } from 'dotenv';

config();

// Values shipped in .env.example. If one of these survives into a production
// deployment, tokens can be forged by anyone who reads the public repository -- the
// schema's min(1) would happily accept them, so they have to be refused by name.
const PLACEHOLDER_SECRETS = new Set([
  'change-this-to-a-long-random-string',
  'change-me',
  'changeme',
  'secret',
  'your-secret-here',
  'replace-me',
  'dev-secret',
]);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  HOST: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((v) => !PLACEHOLDER_SECRETS.has(v.trim().toLowerCase()), {
      message:
        'JWT_SECRET is still the .env.example placeholder; anyone with the public repo could forge admin tokens',
    }),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().optional(),
  ENCRYPTION_SECRET: z
    .string()
    .min(32)
    .refine((v) => !PLACEHOLDER_SECRETS.has(v.trim().toLowerCase()), {
      message: 'ENCRYPTION_SECRET is still the .env.example placeholder',
    }),
  GEMINI_API_KEY: z.string().optional(),
  SNOVIO_API_KEY: z.string().optional(),
  SNOVIO_API_SECRET: z.string().optional(),
  CONTACT_OUT_API_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  ENCRYPTION_SALT: z.string().optional(),
  // Mirrors server.ts `process.env.TRUST_PROXY === 'true'`: set TRUST_PROXY=true
  // only when running behind a trusted reverse proxy (docker-compose web/nginx).
  TRUST_PROXY: z.string().optional(),
  WHATSAPP_WEB_URL: z.string().optional(),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  SCRAPER_MAX_CONCURRENCY: z.string().default('5').transform(Number),
  SCRAPER_TIMEOUT_SECONDS: z.string().default('30').transform(Number),
  SCRAPER_RETRY_ATTEMPTS: z.string().default('3').transform(Number),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.string().default('5').transform(Number),
  CIRCUIT_BREAKER_COOLDOWN_MINUTES: z.string().default('120').transform(Number),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  // Public self-registration is OFF unless an operator opts in. An open /register
  // let anyone create a `sales_rep` account on an internet-reachable deployment
  // and immediately read lead PII. Default-deny is the only safe default; set
  // ALLOW_SELF_REGISTRATION=true for a single-tenant/dev instance.
  ALLOW_SELF_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Shared secret for scraping /metrics. Empty means the endpoint is refused
  // (fail-closed) rather than publicly exposed.
  METRICS_TOKEN: z.string().optional(),
  // Credit budgets surfaced by /dashboard/credits. Overridable per deployment
  // instead of being hardcoded to 1000.
  CREDIT_LIMIT_DEFAULT: z.string().default('1000').transform(Number),
  // JSON object of {provider: limit} overrides, e.g. {"snovio":500}.
  CREDIT_LIMITS: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return {} as Record<string, number>;
      try {
        const parsed = JSON.parse(v) as Record<string, unknown>;
        return Object.fromEntries(
          Object.entries(parsed)
            .map(([k, n]) => [k, Number(n)] as const)
            .filter(([, n]) => Number.isFinite(n) && n > 0),
        );
      } catch {
        return {} as Record<string, number>;
      }
    }),
  // Session cookies carry the refresh token. Mark them Secure only when the
  // deployment actually terminates TLS, otherwise the browser drops the cookie
  // and every refresh silently logs the user out.
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new Error(`Environment validation failed:\n${errors.join('\n')}`);
    }
    _env = result.data;
  }
  return _env;
}

export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
