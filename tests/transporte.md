# Regressão da separação entre captura, pessoa e transporte

Fase 0 da migração para SFU: a malha saiu do `index.html` para
`public/transporte-mesh.js`, atrás do contrato de `public/transporte.js`, e as
fontes ganharam registro próprio (`public/fontes.js`). O comportamento da malha
deve ser o mesmo de antes. O que muda para quem está na sala:

- O anúncio de estado leva `fontes`: `[{ id, tipo, geracao, stream, tela? }]`.
  Os campos antigos (`idsTelas`, `streamId`, `idTela2`, `idCam`) continuam, e
  quem recebe ainda classifica por eles. Clientes anteriores ignoram `fontes`.
- O anúncio de estado não leva mais `de` (id da conexão). Só descrição e
  candidatos o usam, e quem recebe trata o estado antes de olhar `de`.
- O relatório de diagnóstico grava `qualidade` como `{ captura, envio }`.

O protocolo com o Worker não mudou.

## Automático

`node --test tests/*.test.js` cobre o contrato (`tests/transporte.test.js`), o
registro de fontes e a passagem captura → registro → transporte → anúncio
(`tests/fontes.test.js`), além dos testes de reconexão, telemetria e
estatísticas, que agora carregam os scripts na ordem da página
(`tests/cliente.js`).

`tests/e2e/malha.mjs` roda o roteiro abaixo em 3 a 4 contextos do Chromium
headless, com câmera e microfone falsos do Chromium, uma tela falsa (canvas) e
som estéreo falso (440 Hz à esquerda e 660 Hz à direita). Ele usa a Sala de
produção no `wrangler dev` de `desktop/teste/e2e` e o login de membro fixo.
Como as instruções estão no cabeçalho do arquivo, ele fica fora do
`node --test`. O filtro de ruído vai em `navegador`, porque sem gesto o
AudioWorklet não sai do lugar no headless; a captura não é o que está em teste.

## Roteiro

| # | Passo | Esperado |
|---|---|---|
| 1 | A, B e C entram | todos os pares `connected`; canal `telemetria` aberto; um polite e um impolite por par |
| 2 | A compartilha tela com som, liga câmera, fala | B e C veem a tela, a câmera em miniatura, a voz e o som; `fontes` de A traz `tela-video` e `tela-audio` com o mesmo `tela` |
| 3 | B baixa o volume da tela de A | só o `<audio>` da tela muda; a voz fica em 1 |
| 4 | A adiciona outra tela | B tem duas telas para escolher no palco |
| 5 | A recaptura | mesmo número de transceivers e o mesmo SDP remoto em B; quadros continuam; `geracao` 2 nas fontes da primeira tela, ids iguais |
| 6 | A para a primeira tela e depois a câmera | B fica com uma tela e sem câmera; as fontes somem do anúncio |
| 7 | D entra tarde | D recebe a tela e a voz de A |
| 8 | B e C ligam a câmera ao mesmo tempo | as duas câmeras chegam dos dois lados; quem é impolite pode registrar `oferta_ignorada` |
| 9 | C perde o WebSocket | C volta com o mesmo id; a mídia de A segue sem recriar o par |
| 10 | B dá F5 | B volta com id novo e os outros recriam o par com ele; B recebe a tela de A |
| 11 | D fecha a aba | some dos outros |
| 12 | telemetria | `par_criado`, `ice`, `conexao`, `track`, `video_classificado`, `video`, `caminho` chegam ao `/telemetria` |

## Rodado em 02/10/2026 (Mac, Chromium 1243 headless, `wrangler dev`)

Rodei o roteiro na malha nova e, para comparar, num `git archive` da base
`c8aed08` servido pelo mesmo harness.

- Malha nova: 6 rodadas, sem erro de página. Os passos 1 a 6, 8, 9, 11 e 12
  passaram em todas. Na primeira rodada, os passos 5 e 12 falharam por erro do
  próprio roteiro: contava estatísticas logo depois da segunda tela e lia a
  fila de telemetria já esvaziada pelo envio. O roteiro foi corrigido. Os
  passos 7 ou 10 falharam em 2 rodadas.
- Base `c8aed08`: 3 rodadas. Os passos 7 ou 10 falharam em 2 rodadas, com a
  mesma assinatura.

A falha nos passos 7 e 10 é anterior a esta mudança. A ponta que compartilha
é polite e fica em `have-local-offer`, com o transceiver de vídeo sem `mid`. A
outra ponta processa a resposta à primeira oferta e a renegociação ao mesmo
tempo: `receberSinal` é assíncrono e não tem fila. A renegociação chega
enquanto `setRemoteDescription(answer)` ainda está pendente, e a ponta
impolite a vê como colisão e a descarta. Ninguém oferece de novo. A correção
provável é o `isSettingRemoteAnswerPending` do padrão de negociação perfeita,
ou uma fila por par, mas ela muda comportamento e ficou fora desta fase.

Também anterior: depois de parar a tela que levava som, o `<audio>` daquele som
continua no receptor, mudo e classificado como `voz` (passo 6).

Corrigido depois: `removeTrack` no emissor só silencia o áudio no receptor,
sem `ended`, como já acontecia com o vídeo. Cada pessoa guarda, por conexão,
os streams já anunciados como tela; `classificar()` desliga o áudio de um
stream desses que saiu do anúncio, mesmo quando a track chega depois do
anúncio que o tirou. Se ele voltar ao anúncio, volta a valer. O que nunca foi
tela continua voz, então cliente antigo ou sem anúncio não perde o microfone.
Os `<audio>` recebidos nunca entram no DOM e `remove()` sozinho não os
desliga: o descarte é sempre `pause()`, `srcObject = null` e `remove()`, na
classificação, na troca de track do mesmo stream, no `ended` e na saída da
pessoa. O anel de fala tem um medidor por pessoa, preso à entrada de voz:
passa para a voz quando a tela chegou antes, e quem sai fecha o
`AudioContext` e cancela o quadro. O medidor velho para por identidade da
pessoa, não só pelo id. Coberto por `tests/audio-tela.test.js` (11 casos,
com `paused`, `srcObject`, contextos e quadros observáveis; 10 falham com o
`index.html` anterior) e por dois passos em `tests/e2e/malha.mjs`: parar a
tela com som deixa só `voz`, e 3 ciclos de ligar e parar a tela com som não
acumulam áudio. Sem a correção, cada ciclo deixa mais um `voz`
(`voz,voz,voz` → `voz,voz,voz,voz,voz`). O volume por pessoa ainda volta a 1
quando a conexão é recriada: é outro item.

Readmissão do mesmo stream: o áudio de tela retirado (ou que chega já
retirado) fica num mapa de retirados da pessoa, sem `<audio>` e sem `stop()`,
e sai no `ended` ou na recriação. Se o stream volta ao anúncio, a mesma track
volta a tocar como tela, em qualquer ordem entre track e anúncio. No emissor
atual isso não acontece: cada `adicionarTela` é um `getDisplayMedia` com
stream novo, `recapturar` troca a track sem tirar o stream do anúncio, e
`pararTela` tira a tela e para as tracks. A política cobre outra versão de
cliente ou corrida de sinalização, e é a mesma que o vídeo vai seguir.

Retenção: cada track tem no máximo uma associação vigente, contando o que
toca e o que está retirado. A mesma track entregue com outro stream (outra
tela ou voz) perde a associação antiga antes de ganhar a nova, então
readmitir o stream antigo não a toca duas vezes, e cem streams com a mesma
track deixam uma entrada só. O listener de `ended` é um por track. Tracks
distintas retiradas ficam guardadas até o `ended` ou a recriação da pessoa:
na malha, `removeTrack` remoto nem sempre dispara `ended`, então cem telas
retiradas com tracks distintas deixam cem entradas. Não há teto global nem
expiração por ora; um timeout poderia descartar uma tela que ainda vai ser
readmitida. Nenhum caminho chama `stop()` numa track recebida.

## Fica para o Marcus

- Rede real com TURN: `relay_bytes` só aparece com candidato relay local, e o
  harness devolve `/ice` vazio. Conferir no Better Stack, depois de uma chamada
  com "Forçar conexão via relay", que o evento sai ao sair da sala e ao fechar
  a aba.
- Dois celulares (o caso do glare corrigido em 92dcc05), Safari e Firefox.
- Som estéreo de verdade: tons distintos L/R do áudio do sistema chegando
  separados (o harness gera, mas não grava nem compara os canais).
- App desktop empacotado: `desktop/empacotar.mjs` copia `public/` inteiro, então
  os três scripts novos entram sem mudança. Conferir a tela com o áudio sem o
  Discord e a bandeja (compartilhar a última tela e parar) no Windows, com
  `desktop/teste/e2e/rodar.mjs`, que agora lê `pessoas` para gravar o som.
- Pacote desktop antigo contra cliente novo, e o contrário: o anúncio só
  ganhou um campo.
