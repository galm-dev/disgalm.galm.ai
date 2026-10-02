# Disgalm

Sala de voz, vídeo e tela em https://disgalm.galm.ai. O Worker Cloudflare entrega
os assets e as credenciais TURN temporárias; um Durable Object faz a sinalização
WebSocket por sala. A mídia WebRTC passa entre os participantes ou pelo TURN.

## Acesso

O navegador usa o client público `disgalm` do https://auth.galm.ai com OAuth
authorization code + PKCE S256. O único redirect registrado é
`https://disgalm.galm.ai/auth/callback`. Não há client secret. Access e refresh
tokens ficam só na memória da aba; ao recarregar, a pessoa pede um novo login
pelo auth. O auth concede `disgalm:use` a toda conta cadastrada, inclusive novos
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

Em **Ajustes**, a supressão de ruído do microfone tem três modos: RNNoise, que
é o padrão, filtro do navegador ou desligada. A escolha fica salva no navegador
e vale na hora, inclusive no meio da chamada, porque a track enviada é trocada
sem renegociar. No modo RNNoise, o navegador cuida só do eco e do ganho, e a voz
passa pelo `public/rnnoise-worklet.js` num AudioWorklet antes de ir aos pares.
Isso acrescenta 10 ms de atraso. O binário está em `public/vendor/rnnoise/`,
com a origem e as licenças. Se o RNNoise não carregar, a chamada usa o filtro do
navegador e registra o motivo no diagnóstico.

**Testar microfone** grava sem limite de tempo e só toca depois que a pessoa
para de falar. Com RNNoise, grava duas faixas do mesmo trecho, antes e depois
do filtro. As gravações ficam só na memória da aba e são descartadas na
próxima gravação. Fora de uma sala, o teste abre o microfone só durante a
gravação.

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
