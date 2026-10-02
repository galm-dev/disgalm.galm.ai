#!/usr/bin/env bash
# Publica o Worker (e a UI de public/) a partir do master, e só dele.
#
#   npm run deploy
#
# Recusa se: não está no master; o master local difere do origin/master;
# public/ ou worker/ têm alteração não commitada (o wrangler publica o working
# tree, inclusive arquivo solto); ou a produção serve um index.html que não
# está no histórico do master (alguém publicou de outra branch, e publicar
# agora desfaria aquilo). Roda os testes antes e confere a produção depois.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
erro() { echo "deploy recusado: $*" >&2; exit 1; }
hash() { shasum -a 256 | cut -c1-64; }

git fetch -q origin
[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || erro "publique do master (está em $(git rev-parse --abbrev-ref HEAD))"
[ -z "$(git status --porcelain -- public worker/src worker/wrangler.toml)" ] ||
  erro "public/ ou worker/ têm alteração não commitada"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] ||
  erro "o master local difere do origin/master: git pull ou git push antes"

prod=$(curl -fsS https://disgalm.galm.ai/ | hash)
achado=""
for c in $(git rev-list -n 300 HEAD -- public/index.html); do
  [ "$(git show "$c:public/index.html" | hash)" = "$prod" ] && { achado=$c; break; }
done
[ -n "$achado" ] || erro "a produção serve um index.html fora do histórico do master (deploy de outra branch?). Junte essa branch no master antes."
echo "produção atual: $(git log -1 --format='%h %s' "$achado")"

node --test tests/*.test.js >/dev/null || erro "testes falhando (rode npm test)"

(cd worker && { [ -x node_modules/.bin/wrangler ] || npm ci --no-fund --no-audit; } && ./node_modules/.bin/wrangler deploy)

[ "$(curl -fsS https://disgalm.galm.ai/ | hash)" = "$(git show HEAD:public/index.html | hash)" ] ||
  erro "publicado, mas a produção ainda não serve o index.html do master (cache?)"
echo "produção = $(git log -1 --format='%h %s')"
