# Remover sala da lista

O botão "Remover da lista" (3cea9fa) só mexe no `localStorage` (`disgalm.salas` e
`disgalm.ultima`); a sala continua existindo para quem tiver o nome.
`tests/e2e/remover-lista.mjs` confere isso no Chromium headless contra o
`wrangler dev` de `desktop/teste/e2e` (Sala de produção, membro fixo):

1. membro com 3 salas: botão em todas menos na ativa; fora da sala, a última
   sala também ganha o botão;
2. convidado (stub de convite em `/auth.js`, só naquela aba): nenhum botão,
   dentro ou fora da sala;
3. remover tira a sala da lista e, se for a última, limpa `disgalm.ultima`;
   depois de recarregar a página a remoção continua;
4. entrar de novo pelo nome ("Nova sala" ou `?sala=`) funciona e a sala volta
   à lista;
5. nenhum request HTTP nem quadro WebSocket sai entre o clique e 1,5 s depois,
   e nada na sessão é `DELETE` ou cita remover/apagar.

```sh
(cd worker && npm ci)
node worker/node_modules/wrangler/bin/wrangler.js dev -c desktop/teste/e2e/wrangler.toml \
  --ip 127.0.0.1 --port 8787 --persist-to /tmp/disgalm-e2e-persist
PLAYWRIGHT_CORE=/caminho/com/node_modules node tests/e2e/remover-lista.mjs
```

Sai com código 1 se algum passo falhar; o detalhe vai para
`/tmp/disgalm-remover-lista.json`.
