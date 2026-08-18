#!/usr/bin/env bash
# Roda o wrangler via Docker: o pnpm desta máquina está quebrado e não há npm.
#
# HOME aponta para /app de propósito, então a credencial do wrangler fica em
# worker-poc/.config (ignorado pelo git) em vez de sujar o seu HOME real.
#
#   ./wrangler.sh login
#   ./wrangler.sh deploy
#   ./wrangler.sh dev --port 8787
set -euo pipefail
cd "$(dirname "$0")"

exec docker run --rm -it \
  --network host \
  -v "$PWD:/app" -w /app \
  -u "$(id -u):$(id -g)" \
  -e HOME=/app -e npm_config_cache=/tmp/npm \
  node:22-slim \
  npx wrangler "$@"
