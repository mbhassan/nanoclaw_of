#!/bin/bash
set -euo pipefail

: "${NANOCLAW_PROJECT_ROOT:?NANOCLAW_PROJECT_ROOT must be set}"

cd "${NANOCLAW_PROJECT_ROOT}"

if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
  echo "NanoClaw project files not found at ${NANOCLAW_PROJECT_ROOT}" >&2
  exit 1
fi

if [ ! -d node_modules ] || [ ! -f node_modules/.nanoclaw-package-lock ] || ! cmp -s package-lock.json node_modules/.nanoclaw-package-lock; then
  npm ci
  cp package-lock.json node_modules/.nanoclaw-package-lock
fi

npm run build
bash container/build.sh

exec npm start
