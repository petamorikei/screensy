#!/bin/bash
[ "$(jq -r '.stop_hook_active')" = "true" ] && exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0

ERRORS=""
BIOME=$(pnpm exec biome check --no-errors-on-unmatched . 2>&1) || ERRORS+="$BIOME"$'\n'
TSC=$(pnpm -r typecheck 2>&1) || ERRORS+="$TSC"$'\n'
GOVET=$(cd screensy-website && mise exec -- go vet ./... 2>&1) || ERRORS+="$GOVET"$'\n'
GOFMT=$(cd screensy-website && mise exec -- gofmt -l . 2>&1)
[ -n "$GOFMT" ] && ERRORS+="gofmt needs to be run on:"$'\n'"$GOFMT"$'\n'

if [ -n "$ERRORS" ]; then
  jq -n --arg reason "$ERRORS" '{"decision":"block","reason":$reason}'
fi
