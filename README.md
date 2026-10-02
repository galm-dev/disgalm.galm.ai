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

## Operação

```sh
node --test tests/*.test.js
cd worker
npm run check
npx wrangler deploy
```

O Worker usa os secrets existentes de TURN (`CF_TURN_KEY_ID` e
`CF_TURN_API_TOKEN`, com coturn opcional). O login GALM não adiciona nenhum
secret no Disgalm. A configuração do client e dos grants fica no auth.
