#!/usr/bin/env bash
# Empacota, assina com uma identidade ESTÁVEL e instala o Disgalm em
# ~/Applications. O macOS prende a permissão de Gravação de Tela à assinatura:
# com assinatura ad hoc ela muda a cada pacote e a permissão "ligada" passa a
# valer para um app que não existe mais. Com a mesma identidade, a permissão
# sobrevive às versões novas.
#
# Identidade: DISGALM_ASSINATURA, ou a primeira "Apple Development" do
# Keychain, ou um certificado local "Disgalm Local Signing" criado na primeira
# vez (o macOS pede a senha para confiar nele).
set -euo pipefail
cd "$(dirname "$0")"
APP_ID=ai.galm.disgalm
DESTINO="$HOME/Applications/Disgalm.app"
LOCAL="Disgalm Local Signing"

identidade() {
  security find-identity -v -p codesigning | sed -n 's/.*"\(.*\)"/\1/p' | grep -m1 -F "$1" || true
}

criar_local() {
  local d; d=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$LOCAL" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$d/k.pem" -out "$d/c.pem" 2>/dev/null
  openssl pkcs12 -export -legacy -inkey "$d/k.pem" -in "$d/c.pem" -out "$d/i.p12" -passout pass:disgalm
  security import "$d/i.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P disgalm -T /usr/bin/codesign
  echo "O macOS vai pedir a sua senha para confiar no certificado de assinatura local."
  security add-trusted-cert -r trustRoot -p codeSign -k "$HOME/Library/Keychains/login.keychain-db" "$d/c.pem"
  rm -rf "$d"
}

ID=${DISGALM_ASSINATURA:-$(identidade "Apple Development")}
if [ -z "$ID" ]; then
  ID=$(identidade "$LOCAL")
  [ -n "$ID" ] || { criar_local; ID=$(identidade "$LOCAL"); }
fi
[ -n "$ID" ] || { echo "sem identidade de assinatura" >&2; exit 1; }
echo "assinando com: $ID"

[ -d node_modules/electron/dist ] || { npm install --no-fund --no-audit; node node_modules/electron/install.js; }
npm run build:native >/dev/null
env -u ELECTRON_RUN_AS_NODE DISGALM_ASSINATURA="$ID" node empacotar.mjs >/dev/null
NOVO=dist/Disgalm-mac-arm64/Disgalm.app
[ "$(uname -m)" = arm64 ] || NOVO=dist/Disgalm-mac-x64/Disgalm.app

# Requisito designado: é o que o macOS compara para reconhecer o app. Se
# mudou (primeira instalação estável, troca de identidade), a permissão antiga
# é de outro "Disgalm" e só atrapalha.
requisito() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p'; }
ANTES=""; [ -d "$DESTINO" ] && ANTES=$(requisito "$DESTINO")
DEPOIS=$(requisito "$NOVO")

osascript -e 'tell application id "ai.galm.disgalm" to quit' >/dev/null 2>&1 || true
pkill -f "Disgalm.app/Contents/MacOS/Electron" 2>/dev/null || true
sleep 1
mkdir -p "$HOME/Applications"
rm -rf "$DESTINO"
ditto "$NOVO" "$DESTINO"

if [ "$ANTES" != "$DEPOIS" ]; then
  tccutil reset ScreenCapture "$APP_ID" >/dev/null
  echo "assinatura nova: a permissão de Gravação de Tela será pedida uma vez."
fi
# open herda o ambiente; ELECTRON_RUN_AS_NODE faria o Electron sair na hora.
env -u ELECTRON_RUN_AS_NODE open "$DESTINO"
echo "instalado em $DESTINO"
