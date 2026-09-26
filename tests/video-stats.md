# Diagnóstico da qualidade por destinatário

## Caso relatado

Em 07/09/2026, Marcus relatou uma chamada de três pessoas. A compartilhava
1080p a 120 fps enquanto jogava. B recebia bem; C recebia cerca de 320p.
Retransmitir a tela de A por B resolveu naquela chamada. O papel de A pode
ser ocupado por PCs diferentes, inclusive o de Marcus.

A causa continua em aberto. Faltam estatísticas daquela chamada para separar
limitação do encoder, upload do emissor e caminho até cada destinatário.

## Defeito reproduzido e alteração

`acompanharVideo` retornava antes de ler o envio quando não havia vídeo
recebido. Também escolhia o último relatório de vídeo, que podia ser a câmera.

O diagnóstico agora seleciona a track da tela, mede envio e recebimento
separadamente e mostra a limitação declarada pelo navegador. A estimativa
de banda e o caminho direto/relay pertencem ao transporte selecionado.
O rodapé identifica o limite configurado como teto, não como upload medido.

Nenhum preset, teto de bitrate ou parâmetro de adaptação foi alterado.

## Verificação

```sh
node --test tests/video-stats.test.js
git diff --check
```

Oito testes cobrem envio sem recebimento, tela junto de câmera, recebimento
sem envio, câmera sem tela, troca de track, transporte selecionado, campos
ausentes/contadores reiniciados e resultado atrasado após saída do participante.

Também houve um experimento com conexões WebRTC reais no navegador local,
usando canvas como fonte. Não houve captura de microfone, desktop ou jogo.

Antes da alteração, três conexões transmitiam vídeo e os três indicadores de
envio ficavam vazios. As três chegaram a 1920×1080 após a adaptação inicial.

Para tentar refutar a seleção da track, o experimento passou a usar dois
destinatários, tela 1920×1080 e câmera 320×180. Somente no experimento,
`scaleResolutionDownBy = 3` foi aplicado à tela destinada ao segundo par.

| Destinatário | Indicador de envio | Tela medida no receptor | Câmera medida no receptor |
|---|---|---|---|
| B | 1920×1080 | 1920×1080 | 320×180 |
| C | 640×360 | 640×360 | 320×180 |

A diferença foi induzida para verificar o diagnóstico. Não reproduz a causa
da degradação relatada. A fonte sintética e o navegador em segundo plano não
validam desempenho de jogo a 120 fps nem o caminho entre máquinas distintas.

## Próxima medição

Na próxima ocorrência, registrar no emissor as duas linhas de envio na mesma
janela, com o preset e o teto configurados. Conferir também a resolução
recebida por B e C. `limitado: CPU` e `limitado: banda` são classificações
do navegador; banda não distingue sozinha upload compartilhado de caminho ruim
até um destinatário. Ausência do campo não prova ausência de limitação.

Campos de referência: [estatísticas WebRTC](https://www.w3.org/TR/webrtc-stats/).
