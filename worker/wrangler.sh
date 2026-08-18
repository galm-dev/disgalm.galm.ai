#!/usr/bin/env bash
# Roda o wrangler via Docker: o pnpm desta máquina está quebrado e não há npm.
#
# Imagem Debian, não alpine: o binário do workerd é glibc e "wrangler dev"
# falha com ENOENT em musl.
#
# Monta o REPOSITÓRIO inteiro, não só worker/: o wrangler.toml aponta os assets
# para ../public, que só existe se o pai estiver visível dentro do container.
#
# HOME aponta para worker/ de propósito, então a credencial do wrangler fica em
# worker/.config (ignorado pelo git) em vez de sujar o seu HOME real.
#
#   ./wrangler.sh login
#   ./wrangler.sh deploy
#   ./wrangler.sh dev --port 8787
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"

exec docker run --rm -it \
  --network host \
  -v "$REPO:/repo" -w /repo/worker \
  -u "$(id -u):$(id -g)" \
  -e HOME=/repo/worker -e npm_config_cache=/tmp/npm \
  node:22-slim \
  npx wrangler "$@"
