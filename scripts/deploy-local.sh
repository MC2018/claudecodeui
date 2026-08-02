#!/usr/bin/env bash
#
# One-shot local deploy for this fork.
#
# Why this exists: the service runs on the pnpm-managed Node (22.x, ABI 127),
# but the system `npm` runs on Node 18 (ABI 108). A plain `npm install -g`
# therefore builds `better-sqlite3` for the wrong Node, and the app segfaults
# on startup. This script installs, then rebuilds the native binding against
# the exact Node the service uses, verifies it, and restarts.
#
# Usage: scripts/deploy-local.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="$HOME/.local"
PKG="$PREFIX/lib/node_modules/@cloudcli-ai/cloudcli"
UNIT="cloudcli.service"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "Building client + server"
cd "$REPO"
npm run build

log "Installing globally into $PREFIX"
npm install -g --prefix "$PREFIX" .

# The Node that actually runs the service, read from the systemd unit so this
# never hard-codes a path. Falls back to the pnpm node, then PATH node.
SERVICE_NODE="$(systemctl --user cat "$UNIT" 2>/dev/null \
  | sed -n 's/^ExecStart=\([^ ]*node\) .*/\1/p' | head -1)"
[ -x "$SERVICE_NODE" ] || SERVICE_NODE="$HOME/.local/share/pnpm/bin/node"
[ -x "$SERVICE_NODE" ] || SERVICE_NODE="$(command -v node)"
log "Service Node: $SERVICE_NODE ($("$SERVICE_NODE" --version))"

# node-gyp that supports the service Node. The pnpm-bundled one tracks a recent
# version; pick the newest discoverable copy.
NODE_GYP="$(find "$HOME/.local/share/pnpm" -name node-gyp.js -path '*node-gyp/bin*' 2>/dev/null | sort | tail -1)"
if [ -z "$NODE_GYP" ]; then
  echo "Could not locate node-gyp.js under ~/.local/share/pnpm" >&2
  exit 1
fi

log "Rebuilding better-sqlite3 against the service Node"
( cd "$PKG/node_modules/better-sqlite3" && "$SERVICE_NODE" "$NODE_GYP" rebuild --release )

log "Verifying the native binding under the service Node"
"$SERVICE_NODE" -e "const D=require('$PKG/node_modules/better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(x)'); db.prepare('insert into t values(1)').run(); if(db.prepare('select count(*) c from t').get().c!==1) throw new Error('sanity failed'); console.log('better-sqlite3 OK on', process.version);"

# Keep the unit's ExecStart pointing at wherever the package's `bin` entry
# actually lives. Upstream has moved it before (server/cli.js ->
# modules/cli/cli.js); when that happens a stale ExecStart makes the service
# fail to start after an otherwise-successful deploy.
BIN_REL="$(node -e "process.stdout.write(require('$PKG/package.json').bin.cloudcli)")"
BIN_ABS="$PKG/$BIN_REL"
if [ ! -f "$BIN_ABS" ]; then
  echo "Resolved CLI entry does not exist: $BIN_ABS" >&2
  exit 1
fi
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
if [ -f "$UNIT_FILE" ] && ! grep -qF "$BIN_ABS" "$UNIT_FILE"; then
  log "Updating $UNIT ExecStart -> $BIN_REL"
  sed -i "s|^ExecStart=.*|ExecStart=$SERVICE_NODE $BIN_ABS|" "$UNIT_FILE"
  systemctl --user daemon-reload
fi

log "Restarting $UNIT"
systemctl --user restart "$UNIT"

log "Health check"
for _ in $(seq 1 10); do
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:3001/api/auth/status || true)"
  [ "$code" = "200" ] && { echo "healthy (HTTP 200)"; exit 0; }
  sleep 2
done
echo "Service did not report healthy within timeout — check: journalctl --user -u $UNIT -n 40" >&2
exit 1
