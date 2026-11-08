#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
project="zeroagent-smoke-${BASHPID}-${RANDOM}"
smoke_compose() {
  docker compose --file "$repo_root/deploy/compose.smoke.yaml" --project-name "$project" "$@"
}
cleanup() {
  status=$?
  trap - EXIT
  if ((status != 0)); then smoke_compose logs --tail 100 gateway || true; fi
  smoke_compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

smoke_compose config --quiet
smoke_compose up --detach --wait --wait-timeout 120
gateway_response() {
  smoke_compose exec -T gateway curl --silent --show-error --max-time 10 \
    --write-out '\n%{http_code}' "http://127.0.0.1:8080/$1"
}
expect_status() {
  local response actual
  response=$(gateway_response "$1")
  actual=${response##*$'\n'}
  [[ $actual == "$2" ]] || { echo "$1 returned $actual; expected $2" >&2; return 1; }
  if [[ $2 == 200 ]]; then
    grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<< "${response%$'\n'*}"
  fi
}
wait_ready() {
  local response
  for ((attempt = 0; attempt < 60; attempt++)); do
    if response=$(gateway_response readyz) && [[ ${response##*$'\n'} == 200 ]]; then return 0; fi
    sleep 1
  done
  echo 'Gateway readiness did not recover' >&2
  return 1
}

expect_status healthz 200
expect_status readyz 200
for dependency in redis postgres; do
  smoke_compose stop "$dependency"
  expect_status readyz 503
  expect_status healthz 200
  smoke_compose start "$dependency"
  wait_ready
  expect_status healthz 200
done
echo 'Gateway Docker smoke passed: dependency failure/recovery and process liveness'
