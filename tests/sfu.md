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

## Antes de liberar fora da lista de ensaio

O consumo do ensaio é desprezível perto dos 1.000 GB mensais. Mesmo assim,
nenhuma sala fora de `SFU_SALAS` pode usar o SFU antes de:

1. Um DO de orçamento por conta (`worker/src/orcamento.js`), com binding e
   migração no `wrangler.toml`. Ele guarda snapshot mensal, reservas, limites e
   estado de bloqueio, e o gateway consulta e reserva antes de `publicar` e
   `assinar`.
2. Uma coleta horária que some SFU e TURN (o `turn_uso` de `ff53e8c` mede só
   TURN) e grave no DO de orçamento. Snapshot ausente, incompleto ou com mais de
   75 min nega recurso faturável.
3. Bloqueio em 90% (nega promoções e publicações SFU novas) e em 98% (`/ice`
   para de emitir TURN da Cloudflare), com aviso legível no cliente.
4. Credencial TURN curta: TTL de 86.400 s para cerca de 5 min. Testar o que
   acontece com alocações já abertas quando a credencial vence.
5. Lease e fechamento efetivo dos fluxos SFU ativos perto do limite (alarme no
   DO, sem timer periódico), comprovados em ensaio.

Esses itens são a seção 4 do plano (`docs/SFU-INVESTIGACAO.md`, PR #2) e vêm
antes da fase 4.
