#!/usr/bin/env bash
set -euo pipefail
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
mode=${1:-internal}; validate_env
if [[ $mode == internal ]]; then
  compose exec -T app curl --fail --silent http://127.0.0.1:8080/healthz >/dev/null
  compose exec -T app curl --fail --silent http://127.0.0.1:8080/readyz >/dev/null
  exit 0
fi
[[ $mode == public ]] || die "usage: smoke.sh internal|public"
require curl; set -a; source "$ENV_FILE"; set +a
origin=${PUBLIC_ORIGIN:-https://agent.usa0.top}
curl --fail --silent --show-error "$origin/healthz" >/dev/null
curl --fail --silent --show-error "$origin/readyz" >/dev/null
curl --fail --silent --show-error "$origin/" >/dev/null
for path in /ws/v2 /ws/v2/agent /ws/v2/terminal; do
  headers=$(curl --silent --show-error --include --max-time 3 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dXNhMC1zbW9rZS10ZXN0IQ==' -H 'Sec-WebSocket-Protocol: liveagent.v2.pb' "$origin$path" 2>/dev/null || true)
  grep -qE '^HTTP/[0-9.]+ 101' <<<"$headers" || die "WebSocket upgrade failed: $path"
done
if [[ -n ${SMOKE_EMAIL:-} && -n ${SMOKE_PASSWORD:-} ]]; then
  payload=$(printf '{"email":"%s","password":"%s"}' "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
  curl --fail --silent --show-error -H 'content-type: application/json' --data "$payload" "$origin/api/auth/login" >/dev/null
fi
echo "zeroagent public smoke passed"
