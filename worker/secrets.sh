#!/usr/bin/env bash
# Publica as credenciais do TURN como secrets do Worker, a partir de
# ../local/turn.env.
#
# Os valores vão por STDIN de propósito: não viram argumento de linha de
# comando (que apareceria em `ps` e no histórico do shell), não são impressos,
# e o diretório local/ NÃO é montado no container — só o conteúdo do arquivo
# atravessa o pipe.
#
#   ./secrets.sh            # envia
#   ./secrets.sh --dry-run  # só mostra QUAIS chaves iriam, sem valores
set -euo pipefail
cd "$(dirname "$0")"

ENV=../local/turn.env
[ -f "$ENV" ] || { echo "não achei $ENV" >&2; exit 1; }

chaves=$(grep -oE '^[A-Z_][A-Z0-9_]*(?==)' "$ENV" 2>/dev/null || grep -oE '^[A-Z_][A-Z0-9_]*=' "$ENV" | tr -d '=')
echo "chaves em $ENV:"
printf '  %s\n' $chaves

if [ "${1:-}" = "--dry-run" ]; then
  echo "(dry-run: nada enviado)"
  exit 0
fi

echo "enviando (valores não são exibidos)..."
docker run --rm -i \
  -v "$PWD:/app" -w /app \
  -u "$(id -u):$(id -g)" \
  -e HOME=/app -e npm_config_cache=/tmp/npm \
  node:22-slim \
  npx wrangler secret bulk < "$ENV"
