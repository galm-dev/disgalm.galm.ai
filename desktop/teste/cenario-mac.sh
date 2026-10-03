#!/usr/bin/env bash
# Prova do áudio sem o Disgalm e sem o Discord no Mac (tap do Core Audio):
#   1000 Hz — afplay comum: tem de aparecer.
#   440 Hz  — "Discord" (cópia do afplay com esse nome): fora.
#   700 Hz  — tocado pelo próprio app (?proprio=1): fora.
# Usa o app empacotado em dist/mac-arm64 (npx electron-builder --mac dir) e
# grava em teste/saida/<nome> a track antes e depois do WebRTC.
#   ./teste/cenario-mac.sh mac
set -euo pipefail
cd "$(dirname "$0")/.."
nome=${1:-mac}
tmp=${TMPDIR:-/tmp}/disgalm-teste
mkdir -p "$tmp"
for hz in 440 1000; do
  [ -f "$tmp/tom$hz.wav" ] || python3 - "$hz" "$tmp/tom$hz.wav" <<'PY'
import math, struct, sys, wave
hz, f = float(sys.argv[1]), sys.argv[2]
with wave.open(f, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
    w.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * hz * i / 48000))) for i in range(48000 * 5)))
PY
done
cp /usr/bin/afplay "$tmp/Discord"
( while :; do afplay "$tmp/tom1000.wav"; done ) & comum=$!
( while :; do "$tmp/Discord" "$tmp/tom440.wav"; done ) & discord=$!
trap 'kill $comum $discord 2>/dev/null; pkill -x afplay 2>/dev/null; pkill -x Discord -f "$tmp/Discord" 2>/dev/null || true' EXIT
sleep 2
saida="$PWD/teste/saida/$nome"
rm -rf "$saida"
# open passa o ambiente; sem ELECTRON_RUN_AS_NODE, que faria o Electron virar Node.
env -u ELECTRON_RUN_AS_NODE DISGALM_TESTE_QUERY="${QUERY:-proprio=1&semtela=1}" \
  open -n -W dist/mac-arm64/Disgalm.app --args "--teste=$saida"
ls "$saida"
