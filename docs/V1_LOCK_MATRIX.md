# V1 PRODUCTION LOCK — verification matrix

Legend: VERIFIED (evidence this session) | PARTIAL | BROKEN | MISSING | NOT-TESTABLE (env limits, stated)

## 1. Frontend Cloudflare readiness
- [ ] prod build green (fresh run)
- [ ] live security headers (curl evidence)
- [ ] CSP valid, app functional under it
- [ ] SPA fallback + refresh on routes
- [ ] zero localhost in prod paths
- [ ] no secrets in bundle (dist scan)

## 2. Backend VM readiness
- [ ] clean-env boot (compose up works)
- [ ] env validation (all required documented)
- [ ] migrations current (012 applied)
- [ ] health checks live
- [ ] process separation + restart recovery

## 3. Security
- [ ] secret scan clean
- [ ] CORS fail-closed (live)
- [ ] auth on all routes (audit)
- [ ] RBAC server-side (rep/admin cross-test)
- [ ] rate limiting live
- [ ] cookies HttpOnly/SameSite
- [ ] webhooks fail-closed

## 4. Data
- [ ] freshness stored + reclassified
- [ ] scoring 1-10 displayed, explainable
- [ ] dedup/fuzzy working
- [ ] no data loss (refresh/restart E2E)

## 5. Workflows (browser E2E, real backend+DB state)
- [ ] login/logout/refresh/session
- [ ] claim -> persist -> refresh
- [ ] assign (admin->rep, admin->self) -> My Leads
- [ ] enrich -> provenance
- [ ] verify -> status
- [ ] draft -> edit -> save
- [ ] send (blocked paths honest)
- [ ] army run -> confirm -> live status -> stop
- [ ] cross-user isolation (API direct)

## 6. UI/UX + responsive + a11y spot
- [ ] every page loads without errors (8 pages x widths)
- [ ] no overflow 320..1920
- [ ] confirmations everywhere consequential
- [ ] loading/empty/error states

## 7. Resilience
- [ ] api restart recovery
- [ ] workers restart recovery
- [ ] redis restart recovery

## 8. CI/CD
- [ ] exactly 2 workflows, YAML valid
- [ ] commands green locally (= CI steps)

## 9. No half-built / no duplication
- [ ] TODO scan triaged
- [ ] duplicate scan
- [ ] dead buttons/endpoints scan
