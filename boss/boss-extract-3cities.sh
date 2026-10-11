#!/usr/bin/env bash
# Compatibility entrypoint. Scanning logic is shared with Windows in
# boss-extract-driver.mjs; this shim retains the historical score/filter tail.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node boss/boss-extract-driver.mjs "$@"
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    exit 0
  fi
done
npm run boss:score -- --input data/boss-candidates.json
node boss/boss-filter-queue.mjs

echo
echo "=== 完成。下一步：npm run boss:review 生成确认清单，人工确认后才可发送 ==="
