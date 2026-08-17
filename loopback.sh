#!/usr/bin/env bash
# Expõe o áudio do sistema como se fosse um microfone, para o navegador poder
# capturá-lo. No Linux o getDisplayMedia não traz áudio, então este é o caminho.
#
# O módulo é de runtime: morre no reboot. Rode de novo, ou chame pelo autostart.
set -euo pipefail

NOME=webrtc_loopback

if pactl list short sources | grep -q "[[:space:]]$NOME[[:space:]]"; then
  echo "já existe: $NOME"
  exit 0
fi

# O sink padrão pode mudar (fone, HDMI, dock), então nunca fixar o nome.
SINK=$(pactl get-default-sink)
[ -n "$SINK" ] || { echo "não achei o sink padrão" >&2; exit 1; }

pactl load-module module-remap-source \
  master="$SINK.monitor" \
  source_name="$NOME" \
  source_properties=device.description=WebRTC_Loopback >/dev/null

echo "criado: $NOME  (monitor de $SINK)"
echo "o nível independe do volume e do mute do sink — o tap é pré-volume."
