# Ensaio real do SFU da Cloudflare (fase 1)

A fase 1 põe o Cloudflare Realtime SFU atrás do mesmo contrato de transporte da
malha (`public/transporte-cloudflare.js`), com o gateway `worker/src/sfu.js`.
O SFU só liga nas salas de `SFU_SALAS`, com os secrets `SFU_APP_ID` e
`SFU_APP_SECRET`. O README diz como criar o app e montar a lista. Todo o resto
continua em malha, com até 4 pessoas.

## Automático

`node --test tests/*.test.js`:

- `tests/sfu-gateway.test.js`: autorização em cada operação (chave da
  conexão, `sub`, convite vencido, prazo, pessoa que saiu, id de outra pessoa),
  sessão e mids alheios recusados sem chamar a API, assinatura só do catálogo,
  catálogo e sessões depois de recriar o objeto (hibernação), limpeza na saída
  e na chamada nova, falha da API sem segredo nos logs e a rota `/sfu` do Worker.
- `tests/transporte-cloudflare.test.js`: o adaptador contra o gateway de
  verdade e uma API do SFU simulada. Cobre de 2 a 4 clientes com uma
  publicação por fonte, 20 ciclos de publicar, substituir e parar, câmera e
  tela ao mesmo tempo sem mutação simultânea, entrada tardia, nova tentativa de
  assinatura, falha da API, relay forçado e bytes por fonte.
- `tests/reconexao.test.js`: o welcome escolhe o transporte e o cliente manda
  `cap=sfu1`.

Nada disso exercita o SFU de verdade, SDP real nem mídia.

## Ensaio local com o app real (`tests/e2e/sfu.mjs`)

Roda o roteiro em Chromium headless com mídia falsa, contra a Sala e o
Orcamento de verdade num `wrangler dev` local (`tests/e2e/sfu/`) e o app SFU
de verdade. A tela falsa é um canvas animado, e o som do sistema é 440 Hz só à
esquerda e 660 Hz só à direita. O receptor mede o espectro de cada canal. O
orçamento recebe um retrato zerado, porque não há analytics local.

```sh
umask 077
{ grep -E '^SFU_APP_(ID|SECRET)=' ~/.config/disgalm/sfu.env; echo SFU_SALAS=ensaio-sfu-local; } \
  > tests/e2e/sfu/.dev.vars          # ignorado pelo git; apagar ao fim
node worker/node_modules/wrangler/bin/wrangler.js dev -c tests/e2e/sfu/wrangler.toml \
  --ip 127.0.0.1 --port 8788 --persist-to /tmp/disgalm-sfu-persist &
SFU_ENV=~/.config/disgalm/sfu.env PLAYWRIGHT_CORE=/caminho/com/node_modules \
  node tests/e2e/sfu.mjs ensaio-sfu-local
rm tests/e2e/sfu/.dev.vars; rm -rf /tmp/disgalm-sfu-persist
```

Rodado em 02/10/2026, entre 18h44 e 19h10 de Brasília, no Mac (Chromium 1243
headless), em 11 rodadas. As três primeiras acharam os defeitos corrigidos em
`84ec53d`. Resultado das rodadas finais:

| Item do roteiro | Resultado |
|---|---|
| 1–2. 2 → 4 clientes, uma conexão cada, uma publicação por fonte | passou: A publica mic, tela (vídeo e som) e câmera uma vez só com 4 na sala |
| 3. câmera e tela ao mesmo tempo | passou, sem mutação simultânea na sessão |
| 4. publicar, parar e substituir a câmera 20 vezes | passou: 20 de 20 ciclos vistos pelo outro lado, transceivers ativos = publicadas + assinadas. Às vezes sobra um transceiver `inactive` sem mídia (seção que o SFU repete na oferta), que não cresce com os ciclos |
| 5. recapturar a tela 20 vezes | passou: a tela segue viva, sem publicação nova |
| 6. entrada tardia | passou: os dois que entram depois recebem tela, câmera, voz e som |
| 7. estéreo com tons L/R | passou: separação de 51 a 86 dB nos dois canais, igual à malha. Antes de `84ec53d` chegava mono, na malha e no SFU |
| 8–9. Windows e Linux com áudio do sistema | não dá para testar headless |
| 10. relay forçado | não testado: o ensaio local não tem credencial TURN |
| 11. UDP bloqueado | não dá para testar headless |
| 12–13. saída e chamada nova | passou: nenhuma sessão ficou com track ativa na API do SFU |
| 14. sala fora da lista | passou: malha, sem SFU |
| 15–16. cliente antigo | não rodado no e2e (coberto em `tests/sfu-gateway.test.js`) |
| O4 (local). orçamento acima de 90% | passou: a sala de ensaio abre na malha e os dois que entram veem o aviso |

Intermitente: em 4 das 11 rodadas, a primeira conexão de um cliente com o SFU
ficou em `connecting`. Desde `84ec53d` o cliente refaz a sessão depois de 10 s,
e a rodada termina com tudo recebido, mas aparece um `sfu_erro` com
`sem_conexao`. A causa não foi achada; vale olhar num ensaio com rede real.

## Antes do ensaio

- App criado, os dois secrets gravados e uma sala só para o ensaio em
  `SFU_SALAS` (exemplo: `ensaio-sfu`), com o Worker publicado.
- Better Stack aberto na source do Disgalm, filtrando `sala:ensaio-sfu`.
- `chrome://webrtc-internals` (ou `about:webrtc` no Firefox) aberto em pelo
  menos um cliente.
- Em cada cliente, conferir no log da página: `transporte: sfu`.

## Roteiro

| # | Passo | Esperado |
|---|---|---|
| 1 | A entra na sala de ensaio, depois B | welcome com `modo: 'sfu'`; uma `RTCPeerConnection` por cliente, com destino no SFU; `sfu_sessao_criada` para cada um; B ouve a voz de A e vice-versa |
| 2 | C e D entram | cada um com uma conexão só; A continua com uma publicação por fonte (`sfu_publicou` de A não se repete); a subida de A em webrtc-internals não cresce com C e D |
| 3 | A compartilha tela com som e liga a câmera ao mesmo tempo | B, C e D veem a tela, a câmera em miniatura, ouvem o som da tela separado da voz; o volume da tela de A em B muda só o som da tela; nenhum `sfu_erro` com status 409 |
| 4 | A publica, para e substitui (recaptura) a câmera 20 vezes | ao fim, nenhum quadro congelado em B, C e D; em webrtc-internals, o número de transceivers ativos volta ao do início; `sfu_publicou` e `sfu_sessao_fechada`/fechamentos batem com os ciclos; sem `sfu_api_erro` |
| 5 | A recaptura a tela 20 vezes | a tela segue nos outros sem renegociar (`replaceTrack`); nenhuma publicação nova no SFU |
| 6 | E entra tarde (depois de D sair, para caber nos 4) | E recebe tela, câmera, voz e som que já estavam no ar |
| 7 | Estéreo: A toca um tom só à esquerda (440 Hz) e outro só à direita (660 Hz) no áudio do sistema, com o mic aberto | gravar em B o `<audio>` da tela e conferir os dois canais separados (a 440 Hz só em L e a 660 Hz só em R, como em `desktop/teste/analisar.py`); a voz chega em outro elemento; sincronismo entre tela e som sem deriva perceptível |
| 8 | Windows com o app desktop: compartilhar tela com o áudio do sistema (WASAPI, sem o Discord) | os outros ouvem o som do sistema sem o Discord e sem eco do próprio Disgalm |
| 9 | Linux com o app desktop: áudio do sistema pelo PipeWire | idem |
| 10 | Um cliente com "Forçar conexão via relay" | o caminho com o SFU é relay em webrtc-internals; mídia nos dois sentidos; `sfu_conexao` `connected` |
| 11 | Um cliente com UDP bloqueado (firewall) | conecta por TURN/TCP ou TLS; anotar o tempo até a mídia |
| 12 | A fecha a aba | `sfu_sessao_fechada` com motivo `saiu`; as fontes de A somem dos outros sem quadro preso; nenhum `<audio>` de A sobrando |
| 13 | Todos saem; alguém entra de novo | chamada nova, catálogo vazio; o que sobrou é fechado à força (`motivo: chamada_nova`) |
| 14 | Sala fora da lista (por exemplo `galm`) com o mesmo cliente novo | welcome com `modo: 'mesh'`, log `transporte` não aparece, a malha de sempre (roteiro de `tests/transporte.md`) |
| 15 | App desktop antigo (sem `cap=sfu1`) entra na sala de ensaio já em SFU | recebe `cheia` e mostra "Sala cheia"; nenhum loop de reconexão; `sfu_recusado` com `op: 'entrar'` |
| 16 | App desktop antigo abre a sala de ensaio vazia, um cliente novo entra depois | os dois em malha |

Depois do ensaio, conferir no Better Stack:

- `sfu_bytes` por fonte (envio de quem publica, recebimento de quem assina),
  para estimar o consumo do ensaio;
- nenhum evento com nome, email, token, chave ou IP;
- `sfu_api_erro` e `sfu_recusado`: cada um explicado.

Critério de aceite da fase 1: uma publicação por fonte, sem multiplicar por
pessoa, som da tela separado da voz e em estéreo, e reconciliação correta
depois de parar, substituir e sair. Se o estéreo ou a compatibilidade falharem,
comparar o mesmo roteiro com LiveKit antes de seguir (seção 6 do plano).

## O que esta fase não faz

- Roteador adaptativo, simulcast e diagnóstico por assinatura (fases 2 e 4).
  As estatísticas de vídeo por participante ficam vazias no SFU: não há conexão
  por pessoa, e o canal `telemetria` entre pares não existe ali.
- Reconexão longa (fase 3). Se a conexão com o SFU falha, o cliente abre outra
  sessão e publica e assina tudo de novo. Quem cai com volta prevista mantém as
  fontes no catálogo até voltar, até ser descartado como fantasma ou até a
  chamada acabar.
- `substituir` troca a track sem avisar o catálogo: a `geracao` lá fica a da
  publicação.

## Orçamento

Automático (`tests/orcamento.test.js`, mais os casos de orçamento em
`tests/sfu-gateway.test.js`, `tests/transporte*.test.js` e
`tests/reconexao.test.js`): limiares de 90% e 98% com a margem, reservas que
crescem e fecham, reserva TURN podada quando a medição a cobre, retrato
ausente, incompleto ou vencido, coleta pontual com espera de 5 min, virada do
mês, estimativa do SFU sem o dataset, separação do TURN etiquetado
`disgalm-sfu`, cron gravando o retrato, `/ice` negando com o motivo no
cabeçalho, `/sfu` negando publicar e assinar sem chamar a API, renovação da
credencial (malha refaz o ICE só no relay; SFU refaz a sessão) e avisos uma vez
por sala.

Em ambiente real, com cota de verdade:

| # | Passo | Esperado |
|---|---|---|
| O1 | Primeira hora depois do deploy | `orcamento_snapshot` a cada hora, `completo: true`; `sfu_fonte: 'graphql'` se o dataset do SFU responder, senão `sfu_uso_falhou` e `estimativa` |
| O2 | Chamada com "Forçar conexão via relay" por 15 min | `ice_renovado` a cada ~4 min com `reiniciados: 1`; a mídia não cai na troca; nenhum `turn_cloudflare_falhou` |
| O3 | Mesma chamada sem relay forçado | `ice_renovado` com `reiniciados: 0` |
| O4 | Remover temporariamente `CF_ANALYTICS_TOKEN` num ambiente de teste | `/ice` com `x-disgalm-relay: negado;snapshot_*`, aviso de relay uma vez, `rota_cota_bloqueio` com `motivo` de retrato; a sala de ensaio abre na malha com o aviso do SFU |
| O5 | Conferir no painel da Cloudflare (Realtime → uso) contra `orcamento_snapshot` | a soma TURN + SFU bate com o painel, tirando o TURN etiquetado `disgalm-sfu` |

### Modo sem medição

Sem `CF_ACCOUNT_ID`/`CF_ANALYTICS_TOKEN` (decisão do Marcus, 02/10/2026): o
TURN não é bloqueado e o SFU para em 90% da própria conta de assinaturas, que
zera no começo do mês (UTC). Testes em `tests/orcamento.test.js` (TURN liberado
sem retrato, SFU parando em 90%, depois de recriar o objeto, virada do mês,
evento por dia e volta ao modo medido quando os secrets aparecem) e em
`tests/sfu-gateway.test.js`. Na prática, o TURN da Cloudflare fica sem teto
nosso; só o consumo do SFU autorizado pelo gateway entra na conta.

## O que falta antes de liberar fora da lista de ensaio

Já existe: orçamento por conta, reserva, bloqueio em 90%/98%, credencial TURN
de 5 min com renovação. Ainda falta, antes de qualquer sala fora de
`SFU_SALAS` usar o SFU:

1. Confirmar a medição do SFU contra o painel (O5). O dataset
   `callsUsageAdaptiveGroups` não está documentado; até lá, a parte do SFU
   segue pelo teto das assinaturas quando ele é maior.
2. Fechamento ativo de assinaturas perto do limite. Hoje, acima de 90%, o
   gateway só nega o que é novo; o que já está aberto continua até alguém
   fechar ou sair. Isso cabe na margem de 90% a 98% com quatro pessoas, mas
   não com mais.
3. Calibrar `TAXA_TURN` (50 Mbps por credencial) e os tetos por tipo com
   `relay_bytes` e `sfu_bytes` de chamadas reais.
4. Ensaiar a virada do mês (21h de Brasília no último dia) com a cota real.
