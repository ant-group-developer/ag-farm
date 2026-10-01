#!/usr/bin/env bash
# Deploy ag-farm trên VPS: build image, chạy migration, thay api rồi web.
# GitHub Actions gọi script này sau `git pull` (xem .github/workflows/deploy.dev.yml).
set -euo pipefail
cd "$(dirname "$0")"

HEALTH_TIMEOUT_SECONDS=${HEALTH_TIMEOUT_SECONDS:-60}
log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

if [[ ! -f .env ]]; then
  echo "Thieu .env (sao chep .env.example roi dien)." >&2
  exit 1
fi

log 'Build image'
docker compose build api web

if [[ "${SKIP_MIGRATION:-0}" != 1 ]]; then
  log 'Chay migration'
  docker compose run --rm --no-deps api \
    node ../../node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
fi

log 'Thay api'
docker compose up -d --no-deps api

log "Cho api healthy (toi da ${HEALTH_TIMEOUT_SECONDS}s)"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
until docker compose exec -T api node -e "
  fetch('http://127.0.0.1:3010/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    echo 'api khong healthy. Log gan nhat:' >&2
    docker compose logs --tail 50 api >&2
    exit 1
  fi
  sleep 2
done
echo 'api healthy'

log 'Thay web'
docker compose up -d --no-deps web

log 'Xong'
docker compose ps
