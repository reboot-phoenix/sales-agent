#!/usr/bin/env bash
# up.sh - one-shot stack launcher for Linux/macOS.
# Windows users: run .\up.ps1 in PowerShell instead. Same steps, same result.
#
# Usage: ./up.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example — review ADMIN_EMAIL/ADMIN_PASSWORD and API keys in it."
fi

echo "==> Building images & starting stack (postgres, redis, api, web, workers, reacher, n8n)..."
docker compose up -d --build

echo "==> Applying database migrations (idempotent; waits for postgres)..."
migrated=0
for i in $(seq 1 20); do
  if docker compose exec -T api npm run --silent migrate 2>/dev/null; then
    echo "    migrations applied"; migrated=1; break
  fi
  echo "    db/api not ready yet, retrying ($i/20)..."; sleep 3
done
if [ "$migrated" -ne 1 ]; then
  echo "migrations FAILED" >&2; exit 1
fi

echo "==> Bootstrapping admin account (idempotent, reads ADMIN_EMAIL/ADMIN_PASSWORD from .env)..."
for i in $(seq 1 10); do
  if docker compose exec -T api npm run --silent seed:admin:dist 2>/dev/null; then break; fi
  echo "    api not ready yet, retrying ($i/10)..."; sleep 3
done

echo "==> Status:"
docker compose ps
echo ""
echo "    web  http://localhost:5173"
echo "    api  http://localhost:3000/health"
