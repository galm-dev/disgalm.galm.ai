#!/usr/bin/env bash
# Roda cpu.mjs com áudio próprio: PipeWire, WirePlumber e pipewire-pulse deste
# XDG_RUNTIME_DIR, sem ALSA, Bluetooth nem câmera, e um sink nulo como saída.
# Feito para rodar dentro de um compositor de teste, que já dá D-Bus, HOME e
# XDG_RUNTIME_DIR próprios:
#
#   fleet kwin-teste --tempo 1800 -- bash desktop/teste/e2e/cpu-isolado.sh [args do cpu.mjs]
#
# Recusa rodar no XDG_RUNTIME_DIR da sessão: o PipeWire daqui tomaria o lugar
# do áudio de quem está na máquina.
set -euo pipefail
cd "$(dirname "$0")"

case "${XDG_RUNTIME_DIR:-}" in
  /run/user/*/*) ;;
  *) echo "cpu-isolado: XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-vazio} parece o da sessão; rode dentro do compositor de teste" >&2; exit 3 ;;
esac

# O ambiente herdado pode apontar o pulse da sessão; aqui vale só o deste diretório.
export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"
export XDG_CONFIG_HOME="$HOME/.config"
mkdir -p "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"
cat > "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/90-sem-dispositivos.conf" <<'EOF'
wireplumber.profiles = {
  main = {
    monitor.alsa = disabled
    monitor.alsa-midi = disabled
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
    monitor.v4l2 = disabled
    monitor.libcamera = disabled
  }
}
EOF

pipewire & sleep 1
wireplumber & pipewire-pulse &
for _ in $(seq 20); do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl info | grep -q "$XDG_RUNTIME_DIR" || { echo "cpu-isolado: pulse não é o deste diretório" >&2; exit 4; }
# O pulse responde a info antes de aceitar módulos, e o sink criado demora a
# aparecer para set-default-sink.
for _ in $(seq 40); do
  pactl list short sinks 2>/dev/null | grep -q nulo ||
    pactl load-module module-null-sink sink_name=nulo >/dev/null 2>&1 || true
  pactl set-default-sink nulo >/dev/null 2>&1 && break
  sleep 0.5
done
[ "$(pactl get-default-sink)" = nulo ] || { echo "cpu-isolado: sink nulo não ficou como padrão" >&2; exit 5; }

node cpu.mjs "$@"
