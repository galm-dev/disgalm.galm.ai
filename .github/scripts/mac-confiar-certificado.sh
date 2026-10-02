#!/usr/bin/env bash
# O certificado de assinatura do Disgalm é próprio (não é da Apple): o codesign
# só aceita a identidade se o sistema confiar nele. No runner do GitHub há sudo
# sem senha, então a confiança vai no keychain do sistema, sem janela.
# O electron-builder importa o .p12 (CSC_LINK) sozinho depois.
set -euo pipefail
p12="$RUNNER_TEMP/disgalm-assinatura.p12"
pem="$RUNNER_TEMP/disgalm-assinatura.pem"
printf '%s' "$CSC_LINK" | base64 --decode > "$p12"
openssl pkcs12 -in "$p12" -nokeys -passin env:CSC_KEY_PASSWORD -out "$pem" -legacy 2>/dev/null ||
  openssl pkcs12 -in "$p12" -nokeys -passin env:CSC_KEY_PASSWORD -out "$pem"
sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$pem"
openssl x509 -in "$pem" -noout -subject
rm -f "$p12"
