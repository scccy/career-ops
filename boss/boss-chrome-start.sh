#!/usr/bin/env bash
# Compatibility entrypoint. Chrome detection and launch behavior live in Node
# so Unix shells and Windows npm commands use the same implementation.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Preserve the historical Linux BOSS profile directory for users of this shim.
if [[ -z "${BOSS_CHROME_DATA_DIR:-}" && "$(uname -s)" == Linux ]]; then
  export BOSS_CHROME_DATA_DIR="$HOME/.config/google-chrome-boss"
fi

exec node boss/boss-chrome-start.mjs "$@"
