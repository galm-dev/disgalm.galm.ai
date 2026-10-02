# Disgalm

Sala de voz, vídeo e tela em https://disgalm.galm.ai. O Worker Cloudflare entrega
os assets e as credenciais TURN temporárias; um Durable Object faz a sinalização
WebSocket por sala. A mídia WebRTC passa entre os participantes ou pelo TURN.

## Acesso

O navegador usa o client público `disgalm` do https://auth.galm.ai com OAuth
authorization code + PKCE S256. O único redirect registrado é
`https://disgalm.galm.ai/auth/callback`. Não há client secret. Access e refresh
tokens ficam só na memória da aba; ao recarregar ou sair da sala, a pessoa pede
um novo login pelo auth. O auth concede `disgalm:use` a toda conta cadastrada,
inclusive novos cadastros.

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
