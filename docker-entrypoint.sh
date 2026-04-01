#!/bin/bash
set -e

# Install skill dependencies (node_modules) if workspace is mounted
WORKSPACE="${WORKSPACE_PATH:-/workspace}"
if [ -d "$WORKSPACE/.agents/skills" ]; then
  for pkg in "$WORKSPACE"/.agents/skills/*/scripts/package.json; do
    [ -f "$pkg" ] || continue
    dir="$(dirname "$pkg")"
    if [ ! -d "$dir/node_modules" ]; then
      echo "Installing dependencies: $dir"
      (cd "$dir" && npm ci --omit=dev 2>&1 | tail -1)
    fi
  done
fi

exec "$@"
