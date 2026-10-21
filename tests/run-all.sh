#!/usr/bin/env bash
# Roda a suíte completa: unitários (node) + end-to-end (Chromium real).
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d libs/root ] || [ ! -d node_modules ]; then
  echo "Ambiente não preparado. Rodando ./setup.sh primeiro..."
  ./setup.sh || { echo "setup falhou"; exit 1; }
fi

export LD_LIBRARY_PATH="$PWD/libs/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "=================================================================="
echo " 1/10 Unitários (sem navegador)"
echo "=================================================================="
node --test unit/ 2>&1 | tail -12
UNIT=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 2/10 End-to-end (Chromium + extensão carregada)"
echo "=================================================================="
node --test --test-concurrency=1 e2e/extension.test.js 2>&1 | tail -20
E2E1=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 3/10 Fluxos + backup/restauração"
echo "=================================================================="
node --test --test-concurrency=1 e2e/fluxos.test.js 2>&1 | tail -12
E2E6=${PIPESTATUS[0]}
node --test --test-concurrency=1 e2e/backup.test.js 2>&1 | tail -12
E2E7=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 4/10 Content script + diferencial"
echo "=================================================================="
node --test --test-concurrency=1 e2e/content-script.test.js 2>&1 | tail -12
E2E2=${PIPESTATUS[0]}
node --test --test-concurrency=1 e2e/differential.test.js 2>&1 | tail -10
E2E3=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 5/10 Cobertura de rotas de API"
echo "=================================================================="
node --test --test-concurrency=1 e2e/rotas.test.js 2>&1 | tail -12
ROTAS=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 6/10 Disparo em massa (WhatsApp Web simulado)"
echo "=================================================================="
node --test --test-concurrency=1 e2e/campanhas.test.js 2>&1 | tail -12
CAMPANHAS=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 7/10 Links externos (allowlist + DNR)"
echo "=================================================================="
node --test --test-concurrency=1 e2e/links-externos.test.js 2>&1 | tail -12
LINKS=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 8/10 Auditoria de botões (nenhum tráfego externo)"
echo "=================================================================="
node --test --test-concurrency=1 e2e/sem-rede.test.js 2>&1 | tail -16
E2E4=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 9/10 Service worker + prova com DNS da Leadzy derrubado"
echo "=================================================================="
node --test --test-concurrency=1 e2e/service-worker.test.js 2>&1 | tail -14
E2E5=${PIPESTATUS[0]}

echo
echo "=================================================================="
echo " 10/10 Jornada de instalação (popup + primeiros passos)"
echo "=================================================================="
node --test --test-concurrency=1 e2e/primeiros-passos.test.js 2>&1 | tail -14
JORNADA=${PIPESTATUS[0]}

echo
echo "=================================================================="
if [ $UNIT -eq 0 ] && [ $E2E1 -eq 0 ] && [ $E2E2 -eq 0 ] && [ $E2E3 -eq 0 ] && [ $E2E4 -eq 0 ] && [ $E2E5 -eq 0 ] && [ $E2E6 -eq 0 ] && [ $E2E7 -eq 0 ] && [ $LINKS -eq 0 ] && [ $ROTAS -eq 0 ] && [ $CAMPANHAS -eq 0 ] && [ $JORNADA -eq 0 ]; then
  echo " RESULTADO: TUDO PASSOU"
  exit 0
else
  echo " RESULTADO: FALHOU (unit=$UNIT e2e=$E2E1 cs=$E2E2 diff=$E2E3 rede=$E2E4 sw=$E2E5 fluxos=$E2E6 backup=$E2E7 links=$LINKS rotas=$ROTAS campanhas=$CAMPANHAS jornada=$JORNADA)"
  exit 1
fi
