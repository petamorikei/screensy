#!/bin/bash
FILE_PATH=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ] && exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
case "$FILE_PATH" in
  *.js|*.ts|*.json|*.css|*.html|*.md|*.yaml)
    pnpm exec biome check --write --no-errors-on-unmatched "$FILE_PATH" 2>&1
    ;;
  *.go)
    mise exec -- gofmt -w "$FILE_PATH" 2>&1
    ;;
esac
exit 0
