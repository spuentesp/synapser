#!/usr/bin/env bash
# Try Synapser by hand: a throwaway workspace (the billing fixture) + the full UI with chat.
#   scripts/sandbox.sh [port]        then open http://127.0.0.1:<port>/
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
port="${1:-4173}"
box="$(mktemp -d)"
mkdir -p "$box/ws"
cp -r "$here/fixtures/billing/baseline/." "$box/ws/"
cat > "$box/synapser.config.json" <<JSON
{
  "workspace": "$box/ws",
  "stateDir": "$box/state",
  "commands": [
    { "id": "imports", "argv": ["python3", "-c", "import app.schema, app.client"], "timeoutMs": 20000 }
  ],
  "profiles": ["nemotron-worker", "nemotron-repair"],
  "startRequiresApproval": true
}
JSON
[ -f "$here/web/dist/index.html" ] || npm --prefix "$here/web" run build
echo "sandbox: $box"
exec node --env-file="$here/.env" "$here/src/cli/main.ts" serve --config "$box/synapser.config.json" --port "$port"
