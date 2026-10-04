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
Corrigido em 04/10/2026 (seção abaixo).

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

## Renegociação durante a resposta, 04/10/2026

`receberSinal` não tem fila: oferta que chega com `setRemoteDescription(answer)`
pendente já não conta como colisão. É o `readyForOffer` da negociação
perfeita: `p.respostaPendente` fica ligado só enquanto a resposta é aplicada
(`finally`), e o navegador enfileira a oferta atrás dela. A oferta cruzada de
verdade continua igual: impolite ignora, polite volta atrás e responde. Também
não sinaliza mais a continuação de uma conexão que foi recriada enquanto
esperava: ela mandaria a descrição da velha com o id da nova.

`tests/transporte.test.js` cobre a corrida com um stub que enfileira as
descrições e segura a resposta, nos dois papéis, mais a colisão real e a
recriação no meio. Sem a correção, falham o caso impolite (aplica só
`answer`, registra `oferta_ignorada`) e o da recriação (sinal a mais). O caso
polite já passava; ele protege o comportamento.

Os passos 7 e 10 de `tests/e2e/malha.mjs` agora exigem, do lado de quem
compartilha, conexão `stable`, vídeo com `mid` e quadros crescendo no
receptor. Rodado no Mac com load de 34 a 58 (Chromium 1243 headless,
`wrangler dev`):

- Roteiro inteiro, uma vez: o passo 7 passou. O passo 10 falhou por leitura
  cedo demais: a tela já estava viva e os quadros subindo (0 → 28), mas Ana
  ainda estava em `have-local-offer`. Agora o roteiro espera a negociação.
- Só entrada tardia e F5, 3 voltas com espera: 6 de 6, nos dois papéis,
  todas `stable`, com `mid` e quadros crescendo (4 a 9 s até estabilizar).
- O passo 3 (câmera de Ana em B e C) falhou em 2 de 3 rodadas com a correção
  e passou na única rodada da base `ed1a0ea`. Do lado de Ana, a negociação
  estava `stable`, com `mid` nas duas trilhas de vídeo e sem
  `oferta_ignorada`. A causa provável está na sala, não no transporte.
  `alternarCam` publica a câmera e só anuncia `idCam` depois de
  `await listarCams()`. Se a track chega antes, `classificarVideo` a toma por
  fonte não anunciada e a apaga. Ela não volta quando o anúncio chega. Na
  rodada aprovada, a track chegou depois do anúncio (`eCam: true`). A
  thread do áudio viu a mesma falha numa worktree sem esta correção: a
  corrida é anterior, e a base passava por sorte de tempo.

## Câmera que chega antes do anúncio, 04/10/2026

Somando as rodadas, o passo 3 falhou em 6 de 7 com a correção acima e
passou em 3 de 3 na base. A track não anunciada não é mais apagada:
`classificarVideo` a deixa em `p.videos` sem mostrar, e o anúncio que chega
depois a promove a câmera ou tela. Só sai o vídeo que já foi anunciado e
saiu do anúncio (`p.videosAnunciados`), o que mantém a limpeza de câmera e
tela paradas. O caminho de áudio não mudou.

`tests/fontes.test.js` monta o receptor e entrega a track da câmera antes do
anúncio com `idCam`. Sem a correção, a câmera nunca aparece.

E2E focado, uma vez (load de 21 a 36): passo 3 e mais 5 voltas de desligar e
religar a câmera, 12 de 12 em Bia e Caio. Entrada tardia e F5, 2 voltas, 4
de 4 `stable`, com `mid` e quadros crescendo. No passo 3 a câmera chegou
depois do anúncio (`eCam: true`): esta rodada não prova que a corrida
aconteceu no navegador. Quem prova a correção é o teste.

Depois da revisão (`investigacoes/disgalm-revisao-p2.md`, M1), o histórico
guarda todo id que já esteve no anúncio, `idCam` e telas, mesmo sem track, e
não esquece o retirado. Antes, uma track que chegava depois da retirada, ou
uma segunda track atrasada do mesmo stream, ficava pendente para sempre. A
descartada sai de `p.videos` mas não leva `stop()`: o navegador pode
reaproveitar o transceiver e entregar o mesmo `receiver.track` se o stream
voltar. O anúncio atual é conferido antes do histórico, então o mesmo stream
pode voltar. O histórico é da pessoa, e conexão nova cria pessoa nova.

Em aberto: vídeo que nunca é anunciado fica em `p.videos` até `ended` ou até
a pessoa sair. Sem política definida de expiração ou limite, não há descarte;
um prazo pode apagar uma promoção legítima que só chega tarde.

Também da revisão (M2), os testes da negociação ganharam três casos, cada
um derrubado pela sua mutação: resposta rejeitada seguida de oferta em
`have-local-offer` (sem o `finally`, a impolite aceita a oferta) e conexão
recriada com o `setLocalDescription` preso na própria oferta ou na resposta
(sem o guard de cada ponto, sai a descrição velha com o id novo).

Fica para depois (M3): o `PC` do stub troca de estado sem validar a
transição, não faz rollback e não enfileira `createOffer`, `createAnswer` nem
`addIceCandidate`. Por isso answer → offer → answer "funciona" no stub e
responde uma oferta com outra oferta. Validar as transições e modelar a fila
inteira, com rejeição, daria prova de rollback e de glare durante a criação
da oferta. SDP real e celulares continuam dependendo de ensaio.

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
