# Disgalm

Sala de voz, vídeo e tela em https://disgalm.galm.ai. O Worker Cloudflare entrega
os assets e as credenciais TURN temporárias; um Durable Object faz a sinalização
WebSocket por sala. A mídia WebRTC passa entre os participantes ou pelo TURN.

## Acesso

O navegador usa o client público `disgalm` do https://auth.galm.ai com OAuth
authorization code + PKCE S256. O único redirect registrado é
`https://disgalm.galm.ai/auth/callback`. Não há client secret. O access token
fica só na memória da aba. A troca do code e os refreshes passam pelo Worker
(`POST /auth/code`, `/auth/refresh`), que guarda o refresh rotativo no cookie
`__Host-disgalm_refresh` (HttpOnly, Secure, SameSite=Strict, 30 dias) e nunca o
entrega ao JavaScript. Ao recarregar, o app troca esse cookie por um access token
novo e pula a tela de login. As abas serializam a troca com Web Locks, porque o
auth derruba a família se um refresh já usado voltar. "Sair da conta", no perfil,
chama `POST /auth/logout`: o Worker revoga a família no auth e apaga o cookie. A
sessão do próprio auth.galm.ai (7 dias) continua, então entrar de novo pode não
pedir login. O auth concede `disgalm:use` a toda conta cadastrada, inclusive novos
cadastros.

Depois do login, o app entra direto na sala pedida em `?sala=`, na última sala
usada neste navegador ou em `galm`. Nome e foto vêm do `/userinfo` do auth; sem
nome, vale a parte do email antes do `@`. Clicar no perfil, no canto inferior da
barra lateral, troca o nome exibido; o apelido fica salvo no navegador e vai aos
outros participantes no anúncio de estado. A barra lateral lista as salas já
usadas neste navegador e cria salas novas; trocar de sala ou clicar em **Sair**
não recarrega a página nem pede login de novo.

O Worker exige JWT ES256 válido com `iss` do auth, `aud=disgalm`,
`scope=disgalm:use` e `amr` contendo `passkey` antes de responder `/ice` ou abrir
`/ws`. O navegador envia o token de WebSocket em `Sec-WebSocket-Protocol`, não na
URL; a origem também precisa ser a do próprio Disgalm. O Durable Object fecha
o socket quando o access token vence. O cliente renova o token em memória e
retoma a sinalização antes disso, sem interromper a mídia. Remover o grant ou
desativar a conta no auth corta novas emissões; tokens já emitidos duram no
máximo 10 minutos.

Uma pessoa com conta GALM que já esteja conectada à sala pode clicar em
**Convidar**. O Worker cria um link específico daquela sala, válido por 24 horas,
que pode ser usado por várias pessoas. O convite fica no fragmento da URL e a
página o remove ao abrir. O navegador do convidado recebe um cookie HttpOnly,
Secure e SameSite=Lax, também válido até o fim do convite. O convidado não
precisa de login e não pode criar outro convite nem entrar em outra sala. Ele
precisa que pelo menos um membro GALM esteja conectado para ingressar ou
reconectar. O limite da sala continua em quatro pessoas no total. Para encerrar
um convite antes do prazo, ainda é necessário remover seu registro no Durable
Object da sala; não há botão de revogação na interface.

Os arquivos estáticos são públicos, mas não concedem acesso à sala nem ao
TURN sem conta ou convite. `server.js` é o servidor antigo para teste local e não tem essa proteção;
não o publique na rede.

## Microfone

Em **Ajustes**, a supressão de ruído do microfone tem quatro modos: RNNoise,
que é o padrão, DeepFilterNet, filtro do navegador ou desligada. A escolha
fica salva no navegador e vale na hora, inclusive no meio da chamada, porque a
track enviada é trocada sem renegociar. Nos dois modos neurais, o navegador
cuida só do eco e do ganho, e a voz passa por um AudioWorklet antes de ir aos
pares. O RNNoise (`public/rnnoise-worklet.js`) é leve e acrescenta 10 ms. O
DeepFilterNet3 (`public/deepfilter-worklet.js`) tira bem mais ruído, inclusive
teclado e cliques, mas acrescenta 40 ms e baixa um WASM de 12 MB na primeira
vez. Os binários estão em `public/vendor/`, com a origem e as licenças. Se o
filtro escolhido não carregar, a chamada usa o filtro do navegador e registra o
motivo no diagnóstico.

**Testar microfone** grava sem limite de tempo e só toca depois que a pessoa
para de falar. Com um filtro neural, grava duas faixas do mesmo trecho, antes e
depois do filtro. As gravações ficam só na memória da aba e são descartadas na
próxima gravação. Fora de uma sala, o teste abre o microfone só durante a
gravação.

## Várias telas

Sem tela compartilhada, o botão **Tela** compartilha direto. Com alguma, ele
mostra quantas e abre um menu: **Adicionar tela** abre o seletor de novo, e
cada tela tem seu **Parar**, com o tipo (monitor, janela ou aba) para saber
qual é. Só uma tela leva o áudio do sistema; nas outras ele tocaria em dobro.
Quem assiste escolhe no palco qual tela ver, por pessoa. Todas as telas vão a
todos os pares e dividem o teto de bitrate da tela. Recapturar refaz só a
primeira. Um cliente de versão anterior vê só a primeira ou as duas primeiras.

## Captura, pessoas e transporte

O cliente continua sem bundler: o `index.html` carrega scripts clássicos, na
ordem. `public/fontes.js` guarda o que a aba publica como fontes lógicas (`mic`,
`camera`, `tela-video`, `tela-audio`), com id, dono e geração. Vídeo e áudio
da mesma tela levam o mesmo id de tela, e recapturar sobe a geração sem mudar o
id. `public/transporte.js` descreve o contrato do transporte, e
`public/transporte-mesh.js` o implementa com uma `RTCPeerConnection` por
pessoa: criação, negociação perfeita, Opus estéreo, canal `telemetria` e
remoção. O `index.html` fica com a captura, a sinalização, as pessoas (o mapa
`pessoas`, separado do mapa de conexões `pares`) e o diagnóstico. O anúncio de
estado leva o catálogo de fontes em `fontes`; clientes anteriores ignoram o
campo. Roteiro de regressão em `tests/transporte.md`.

## SFU da Cloudflare (ensaio, fase 1)

`public/transporte-cloudflare.js` implementa o mesmo contrato sobre o
[Cloudflare Realtime SFU](https://developers.cloudflare.com/realtime/sfu/): uma
conexão só por cliente, cada fonte publicada uma vez e assinatura em camada
única do que está no catálogo da sala. O navegador nunca chama a API do SFU.
Ele pede ao Worker (`POST /sfu?sala=…`) uma das operações `sessao`,
`publicar`, `assinar`, `renegociar`, `fechar` e `encerrar`, e
`worker/src/sfu.js` faz a chamada com o App Secret depois de conferir:

- membro GALM pelo bearer ou convidado pelo cookie, como no `/ice`;
- a conexão viva com aquele id na sala, pela chave que o welcome entregou a
  ela (o Durable Object guarda só o hash), com o mesmo `sub` ou um convite que
  ainda vale, dentro do prazo do token e da conexão;
- que a sessão é de quem pede, que os mids a fechar são dessa sessão e que o
  alvo da assinatura está no catálogo, publicado por quem está na sala.

O cliente não manda nem recebe `sessionId` de outra pessoa nem `trackName`.
Catálogo, sessões e versão da sala ficam no storage do Durable Object e
sobrevivem à hibernação. Não há timer novo no objeto, e o ping continua com
resposta automática.

O welcome diz o modo: `modo: 'sfu'` com `sfu: { chave, versao, fontes }`, ou
`modo: 'mesh'`. Quem abre a sala vazia decide o modo da chamada. O SFU só liga
se a sala estiver em `SFU_SALAS`, os secrets do app existirem e o cliente
mandar `cap=sfu1`. Cliente antigo fica na malha. Se a chamada já está em SFU,
ele recebe `cheia` e não entra; se ele abriu a sala, a chamada inteira fica na
malha. O limite continua 4.

Telemetria do SFU, sem nome, email, token, chave nem IP: `sfu_sessao_criada`,
`sfu_sessao_fechada`, `sfu_publicou`, `sfu_assinou`, `sfu_api_erro` e
`sfu_recusado` do Worker; `sfu_conexao`, `sfu_erro` e `sfu_bytes` (bytes por
fonte, envio e recebimento) do navegador.

### O que criar para o ensaio

1. No painel da Cloudflare, **Realtime → Serverless SFU**
   (<https://dash.cloudflare.com/?to=/:account/realtime/sfu>), crie um app só
   para o Disgalm, por exemplo `disgalm-ensaio`. Guarde o **App ID** e o
   **App Secret**.
2. Em `worker/`, grave os dois como secrets (o valor é pedido no terminal e
   não fica no histórico):

   ```sh
   npx wrangler secret put SFU_APP_ID
   npx wrangler secret put SFU_APP_SECRET
   ```

   Também podem ir em `local/turn.env` e subir com `./secrets.sh`.
3. Escolha uma sala só para o ensaio, por exemplo `ensaio-sfu`, e ponha o nome
   em `SFU_SALAS` no `worker/wrangler.toml`. Use minúsculas, como na URL, e
   separe várias salas por vírgula: `SFU_SALAS = "ensaio-sfu"`. Depois,
   publique o Worker.
4. Para desligar, deixe `SFU_SALAS = ""` e publique. Todas as salas voltam à
   malha na próxima chamada. Apagar os secrets tem o mesmo efeito.

Ainda não existe controle de orçamento do SFU (ver o fim de `tests/sfu.md`).
Não ponha salas de uso diário na lista. Roteiro do ensaio real em
`tests/sfu.md`.

## Diagnóstico

As estatísticas de vídeo por participante (resolução, bitrate, limitação) só
aparecem com **Ajustes → Mostrar estatísticas de vídeo nos participantes**.

Cada navegador manda eventos das próprias conexões a `POST /telemetria`, a cada
10 s e ao sair: servidores ICE, tipos de candidato, estados de ICE e conexão,
caminho escolhido, pares de candidatos na falha, tracks recebidas e sua
classificação, transições de qualidade, erros de câmera e de negociação. O
Worker exige membro GALM ou convidado da sala e a origem própria. Ele limita o
lote a 100 eventos e 64 KiB e acrescenta sala, papel e `sub`. Os logs do Worker
(TURN da Cloudflare e entrada e saída na sala) seguem o mesmo caminho. Na
entrada, cada par existente leva `mesmoIpPublico`: o Durable Object compara
hashes com sal do `CF-Connecting-IP` e nunca loga o IP. Os eventos não levam
nome, email, IP, SDP nem credencial; os pares aparecem pelo id de conexão.

Tudo vai ao `console.log` do Worker. Com os secrets `BETTERSTACK_TOKEN` e
`BETTERSTACK_HOST`, também vai ao Better Stack. O plano gratuito do Workers não
tem Logpush, então o próprio Worker faz o envio.

De hora em hora (cron `10 * * * *`), o Worker consulta o consumo do TURN da
Cloudflare e manda o evento `turn_uso`: `egress_bytes_periodo` e
`ingress_bytes_periodo` da hora cheia anterior, `egress_bytes_mes`,
`ingress_bytes_mes`, `egress_gb_mes` e `cota_pct` do mês corrente em UTC. Só o
egress é cobrado, e os 1.000 GB grátis por mês são divididos com o SFU. Falha
na consulta vira `turn_uso_falhou`. O dado vem do dataset
`callsTurnUsageAdaptiveGroups` da [GraphQL Analytics
API](https://developers.cloudflare.com/realtime/turn/analytics/) e soma a conta
inteira, não só a chave TURN do Disgalm. O mês da fatura pode não coincidir com
o mês civil em UTC.

## Operação

```sh
node --test tests/*.test.js
cd worker
npm run check
npx wrangler deploy
```

O Worker usa os secrets existentes de TURN (`CF_TURN_KEY_ID` e
`CF_TURN_API_TOKEN`, com coturn opcional). O SFU de ensaio usa `SFU_APP_ID` e
`SFU_APP_SECRET`, e a lista `SFU_SALAS` do `wrangler.toml`.
Para o evento `turn_uso`, são necessários mais dois secrets. Sem eles o cron não
faz nada.

- `CF_ACCOUNT_ID`: o Account ID da conta onde está a chave TURN (aparece na
  página inicial da conta no painel da Cloudflare).
- `CF_ANALYTICS_TOKEN`: um token de API da conta (My Profile → API Tokens →
  Create Token → Custom token) com a permissão **Account → Account Analytics →
  Read**, restrito a essa conta. O `CF_TURN_API_TOKEN` não serve: é o token da
  chave TURN e só gera credenciais.

```sh
cd worker
./wrangler.sh secret put CF_ACCOUNT_ID
./wrangler.sh secret put CF_ANALYTICS_TOKEN
./wrangler.sh deploy   # publica também o cron
```

O login GALM não adiciona nenhum
secret no Disgalm. A configuração do client e dos grants fica no auth.
