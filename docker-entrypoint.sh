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

if [ -n "${ANTHROPIC_BASE_URL:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  node --input-type=module <<'NODE'
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const path = '/home/node/.claude/settings.json';
let settings = {};
try {
  settings = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  settings = {};
}

settings.env = {
  ...(settings.env || {}),
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || '',
  ANTHROPIC_MODEL: process.env.AGENT_MODEL || '',
};
delete settings.env.ANTHROPIC_API_KEY;

mkdirSync('/home/node/.claude', { recursive: true });
writeFileSync(path, JSON.stringify(settings));
NODE
fi

exec "$@"
