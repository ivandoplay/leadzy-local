#!/usr/bin/env bash
# Prepara o ambiente para rodar os testes E2E (Chromium + extensão carregada).
# Roda uma vez. Precisa de rede e de `apt-get download` (não precisa de root).
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1. dependências Node + Chromium do Playwright"
npm install --no-audit --no-fund
npx playwright install chromium

echo "==> 2. bibliotecas de sistema do Chromium (extraídas localmente, sem root)"
# O Chromium precisa de libnspr4/libnss3/libatk/libcups etc. Sem root não dá para
# apt-get install, então baixamos os .deb e extraímos em libs/root.
if [ -d libs/root ]; then
  echo "    libs já presentes, conferindo links"
else
  mkdir -p libs/debs libs/root
  PKGS=$(apt-cache depends --recurse --no-recommends --no-suggests \
        --no-conflicts --no-breaks --no-replaces --no-enhances \
        libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
        libatspi2.0-0t64 libcups2t64 libxkbcommon0 libxdamage1 2>/dev/null \
      | grep -E '^[a-zA-Z0-9]' | sed 's/:.*//' | sort -u \
      | grep -vE '^(libc6|libgcc|libstdc|multiarch|gcc|dpkg|debconf|base-)')
  ( cd libs/debs && apt-get download $PKGS )
  for d in libs/debs/*.deb; do dpkg-deb -x "$d" libs/root/; done
fi

# Os .deb extraídos trazem arquivos versionados (libatk-1.0.so.0.25611.1) e
# links simbólicos (libatk-1.0.so.0). Links não sobrevivem ao snapshot do
# workspace, então recriamos sempre — sem isso o Chromium não abre.
echo "    recriando links simbólicos das bibliotecas"
find libs/root -type f -name 'lib*.so.*.*' 2>/dev/null | while read -r f; do
  base=$(basename "$f")
  soname=$(echo "$base" | sed -E 's/^(.*\.so\.[0-9]+).*/\1/')
  dir=$(dirname "$f")
  [ "$base" = "$soname" ] && continue
  [ -e "$dir/$soname" ] || ln -sf "$base" "$dir/$soname"
done

echo "==> 3. certificado TLS local para o teste do content script"
if [ ! -f certs/cert.pem ]; then
  mkdir -p certs
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout certs/key.pem -out certs/cert.pem -days 3650 \
    -subj "/CN=web.whatsapp.com" -addext "subjectAltName=DNS:web.whatsapp.com" 2>/dev/null
fi

echo
echo "Pronto. Rode: ./run-all.sh"
