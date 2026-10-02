# Sala pela metade depois de chamada longa

## Caso relatado

Em 25/09/2026, Marcus relatou uma chamada longa sem compartilhamento de tela.
Quando alguém tentou compartilhar, a sala tinha se desfeito. A pessoa deu F5
e entrou numa sala pela metade. Todos precisaram dar F5 para voltar.

## Mecanismo encontrado no código

A mídia vai direto entre os pares. O WebSocket da sala só carrega negociação.
Quando ele cai, a voz continua e ninguém percebe. Compartilhar a tela exige
uma nova oferta, e `sinalizar` a descartava em silêncio com o socket fechado.

- O cliente não reconectava. O botão "Entrar novamente" recarregava a página.
- Cada entrada gerava um id novo. O id da página recarregada virava fantasma
  para quem ainda tinha a conexão antiga.
- Sem batimento, uma conexão meio aberta continuava na lista do Durable Object.
  Quem chegava tentava negociar com um fantasma.
- A Cloudflare derruba todos os WebSockets de um Durable Object quando ele
  reinicia, por deploy ou atualização do runtime. Isso bate com "todo mundo
  teve que dar F5". Não há log daquela chamada que confirme esta causa.

## Alteração

- O cliente pinga a cada 20 s. O Worker responde por `setWebSocketAutoResponse`,
  sem acordar o objeto hibernado. Após 45 s sem mensagens, o cliente descarta
  o socket com código 4000 e reconecta.
- Após uma queda, o cliente reconecta com espera de 1, 2, 4, 8 e 15 s, e para
  quando a sala está cheia. Os eventos `online` e de volta à aba antecipam a
  tentativa.
- O cliente reconecta com o mesmo id e a mesma aba, guardada em `sessionStorage`.
  O Worker substitui o socket antigo e avisa `peer-back`, sem `peer-left`.
  As `RTCPeerConnection` continuam, e ofertas pendentes são reenviadas.
  Depois de um reinício do objeto, o id também é retomado.
- Um F5 na mesma aba, sem o id, remove o socket antigo e avisa a saída.
- O Worker remove quem passou 60 s sem batimento. Clientes antigos, sem `aba`,
  não entram nessa regra.
- `peer-left` informa `volta`. Códigos 1000 e 1001 indicam saída; 1006, 4000 e
  erro indicam queda. Em uma queda, a conexão continua enquanto houver mídia.
  O par só sai quando a mídia morre e a pessoa não voltou.
- Cada conexão entre pares tem um id enviado em todas as mensagens. Uma oferta
  de outra instância recria a conexão local, e mensagens da instância velha
  são ignoradas.
- Polite e impolite passam a depender da ordem dos ids. Assim, os dois lados
  concordam nos papéis quando recriam as conexões ao mesmo tempo.
- ICE `failed` com sinalização aberta chama `restartIce()`.

## Verificação

```sh
node --test tests/*.test.js
```

`tests/reconexao.test.js` cobre o cliente: retomada com reenvio de oferta,
manutenção de par com mídia viva, troca de id, papéis, saída com `volta`,
`peer-back`, recriação por instância nova, estado vindo de instância nova,
batimento e espera entre reconexões.

`tests/sala-worker.test.js` cobre o Durable Object com runtime simulado:
auto-resposta, entrada, retomada, F5, id retomado após reinício, id em uso,
fantasma, vaga ocupada por fantasma e código de fechamento.

No workerd real, via `wrangler dev`, com clientes WebSocket do Node:

- ping recebeu pong;
- sinal com `de` foi repassado;
- retomada devolveu o mesmo id, `retomada: true` e `peer-back`, sem `peer-left`;
- fechamento 4000 gerou `volta: true`, e fechamento 1000 gerou `volta: false`;
- F5 da mesma aba gerou `peer-left` `volta: false` para o id antigo;
- conexão sem ping foi removida após 66 s, e a que pingava continuou.

Não foi testada uma chamada completa no navegador com queda real da rede.
