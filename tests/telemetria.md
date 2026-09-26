# Tela pixelada e telemetria de diagnóstico

## Caso relatado

Em 25/09/2026, Marcus viu a tela de outra pessoa chegar em 320x180 a 35 fps,
com 120 kbps e 20 congelamentos. A imagem demorava a ficar nítida.

## Causa reproduzida

A tela usa `contentHint = 'motion'` nos presets de movimento. Sem uma
`degradationPreference` explícita, o Chrome mantém os quadros e reduz a
resolução quando falta banda. Os presets de movimento incluem o padrão.

Experimento no Chrome 152, com duas `RTCPeerConnection` locais e canvas
1920x1080 animado como fonte. A banda foi limitada por `maxBitrate`.

| preferência          | teto      | resultado após 10–12 s                  |
| -------------------- | --------- | --------------------------------------- |
| padrão (`motion`)    | 150 kbps  | 320x180 @29 fps, limite `bandwidth`     |
| `maintain-resolution`| 150 kbps  | 1920x1080 @2 fps, limite `none`         |
| padrão (`motion`)    | 1000 kbps | 480x270 @30 fps, sem subir em 10 s      |
| `maintain-resolution`| 1000 kbps | 1920x1080 @21–30 fps                    |
| `maintain-resolution`| 500 kbps  | 1920x1080 @5–11 fps                     |
| `balanced`           | 150 kbps  | 480x270 @0–5 fps                        |

A primeira linha reproduz o relato. A terceira mostra por que a imagem demora
a estabilizar: mesmo com banda, a resolução reduzida sobe devagar.

A banda baixa daquela chamada continua sem causa conhecida. O receptor não
tinha dados do emissor para separar CPU, upload, relay ou perda.

## Alteração

A tela agora usa `degradationPreference = 'maintain-resolution'`. Sem banda,
os quadros caem e a resolução fica. A câmera não mudou. Se o navegador não
aplicar a preferência, o log registra o valor lido do sender.

Quando falta banda, o Chrome relata o limite `none` nesse modo. O diagnóstico
detecta a falta quando o encoder envia menos da metade dos quadros capturados.

## Telemetria

- Todas as linhas do log levam hora e ficam em buffer de 2000 eventos.
- A cada 2 s, cada par guarda uma amostra, mantendo as últimas 150 (5 min).
  A amostra cobre envio, recepção, transporte e configuração do encoder:
  resolução, fps, kbps, alvo, captura, limitação, codec e encoder/decoder.
  Também guarda perda, RTT, jitter, buffer, congelamentos e quadros descartados.
  Inclui ainda o caminho com protocolo até o TURN e a estimativa de banda.
- Cada lado envia ao outro seu resumo de envio pelo data channel negociado
  `telemetria` (id 0). Assim, o receptor sabe por que o emissor degradou.
  O canal é direto entre pares, sem mensagens no Durable Object.
- O palco mostra a causa provável, que é registrada no log quando muda.
- O log registra mudanças de caminho e de limitação de envio, além do
  `connectionState` de cada par.
- "Baixar relatório de diagnóstico", nos ajustes, gera um JSON com eventos,
  amostras, pares atuais, pares que saíram e configuração local.

## Verificação

```sh
node --test tests/*.test.js
git diff --check
```

`tests/telemetria.test.js` cobre causa relatada via TURN/tcp, ordem das causas,
fps sem banda em `maintain-resolution`, relato vencido, conteúdo enviado pelo
canal, log só em transições, limite de 150 amostras, preferência aplicada só
na tela e o relatório. O canal negociado foi aberto e entregou mensagem entre
duas conexões reais no Chrome 152.

Não foi testada uma chamada completa com captura real de tela.
