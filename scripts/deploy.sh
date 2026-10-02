#!/usr/bin/env bash
# Publica o Worker (e a UI de public/) a partir do master, e só dele. Quem roda
# é o GitHub Actions (job "deploy" do ci.yml), depois dos testes de cada push
# no master. Na máquina de alguém o script só explica isso: publicar é dar push.
#
# Recusa se: o commit não é mais o topo do origin/master (outro push chegou e o
# run dele publica); ou a produção serve um index.html que não está no
# histórico do master (alguém publicou de outra branch, e publicar agora
# desfaria aquilo). Roda os testes antes e confere a produção depois.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
erro() { echo "deploy recusado: $*" >&2; exit 1; }
hash() { shasum -a 256 | cut -c1-64; }

[ "${GITHUB_ACTIONS:-}" = true ] ||
  erro "o deploy sai do GitHub Actions: junte no master e dê push (o job deploy do CI publica)"

git fetch -q origin master
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]; then
  echo "o origin/master já está em $(git rev-parse --short origin/master): o run daquele push publica"
  exit 0
fi

prod=$(curl -fsS https://disgalm.galm.ai/ | hash)
achado=""
for c in $(git rev-list -n 300 HEAD -- public/index.html); do
  [ "$(git show "$c:public/index.html" | hash)" = "$prod" ] && { achado=$c; break; }
done
[ -n "$achado" ] || erro "a produção serve um index.html fora do histórico do master (deploy de outra branch?). Junte essa branch no master antes."
echo "produção atual: $(git log -1 --format='%h %s' "$achado")"

node --test tests/*.test.js >/dev/null || erro "testes falhando (rode npm test)"

(cd worker && npm ci --no-fund --no-audit && ./node_modules/.bin/wrangler deploy)

# A borda leva alguns segundos para servir os assets novos.
esperado=$(git show HEAD:public/index.html | hash)
for _ in $(seq 24); do
  [ "$(curl -fsS "https://disgalm.galm.ai/?deploy=$(git rev-parse --short HEAD)" | hash)" = "$esperado" ] && {
    echo "produção = $(git log -1 --format='%h %s')"; exit 0; }
  sleep 5
done
erro "publicado, mas a produção não serve o index.html do master depois de 2 min"
