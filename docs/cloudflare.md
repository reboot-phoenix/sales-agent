# Cloudflare frontend deployment

Origin: the `web` container (nginx, port 80) serving the Vite build with
`try_files $uri $uri/ /index.html` SPA fallback. Cloudflare sits in front.

## DNS / TLS

- Point the hostname at the VM; Cloudflare TLS mode **Full (strict)**.
- HSTS: enable at Cloudflare (HTTP Strict Transport Security), not in nginx —
  the container serves plain HTTP behind the proxy and must not emit HSTS itself.
  The nginx config has the HSTS line ready but commented for this reason.

## Caching

- `/assets/*` (hashed, content-addressed): edge-cache aggressively, respect origin
  `Cache-Control: public, immutable` (1y).
- `/index.html` and `/`: **never cache** at edge (`no-cache, no-store,
  must-revalidate`) — a cached entry pins browsers to the previous release's
  chunk filenames.
- **Never cache** `/api/*`, `/sse/*`, `/ws/*` (authenticated/dynamic). Create a
  Cloudflare Cache Rule: bypass cache for those paths. API also sends
  `Cache-Control: no-store` on every response as defense in depth.

## WAF / security

- Security headers + minimal CSP are emitted by nginx (`packages/web/nginx.conf`)
  and mirrored in `packages/web/public/_headers` for Pages-style hosts.
  Cloudflare passes them through; do not strip them.
- CSP allowlist rationale: `script-src 'self'` only (no inline/eval);
  `style-src` includes `'unsafe-inline'` (Tailwind runtime + Vite) and Google
  Fonts; `img-src` allows `data: https:` (company logos); `connect-src`
  allows `self https: wss:` (API/SSE/WS same-origin + TLS upgrades).
- CORS: API sends CORS headers only for origins in `CORS_ORIGIN`
  (comma-separated, e.g. `CORS_ORIGIN=https://app.example.com`). Same-origin
  Docker deploys leave it unset (no CORS headers = correct).

## WebSockets / SSE

- `/ws` upgrades via nginx (`Upgrade`/`Connection` headers preserved).
- `/sse` proxies to the API with buffering off and 1h read timeout.
- Cloudflare: leave WebSockets enabled; SSE rides the 100s+ idle timeout —
  the client auto-reconnects via `useSSE` with backoff.
