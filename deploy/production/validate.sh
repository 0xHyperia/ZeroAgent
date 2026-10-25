#!/usr/bin/env bash
set -euo pipefail
dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for script in "$dir"/*.sh; do bash -n "$script"; done
network_created=false
if ! docker network inspect usa0-edge >/dev/null 2>&1; then
  if docker network create usa0-edge >/dev/null 2>&1; then network_created=true; else docker network inspect usa0-edge >/dev/null; fi
fi
trap '$network_created && docker network rm usa0-edge >/dev/null 2>&1 || true' EXIT
ENV_FILE="$dir/.env.example" docker compose --env-file "$dir/.env.example" -f "$dir/compose.yaml" config --quiet
grep -Eq '^APP_IMAGE=.*@sha256:' "$dir/.env.example"
if grep -n 'ports:' "$dir/compose.yaml"; then
  echo "production compose must not publish host ports" >&2
  exit 1
else
  ports_status=$?
  if [ "$ports_status" -ne 1 ]; then
    echo "could not inspect production compose for published ports" >&2
    exit "$ports_status"
  fi
fi
echo "zeroagent production deploy assets are valid"
