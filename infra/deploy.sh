#!/usr/bin/env bash
# Builds the web app for exeunt.space, packs the repository and provisions the demo server on GCP.
# Requires an authenticated gcloud. Usage: bash infra/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="${GCP_PROJECT:-exeunt-space}"
ZONE="${GCP_ZONE:-asia-southeast1-b}"
VM="${GCP_VM:-exeunt-vm}"
GCLOUD="${GCLOUD:-gcloud}"
# Relative path: GNU tar on Windows treats "C:" as a remote host, and gcloud needs a native path.
OUT=".release/exeunt-release.tgz"
API="https://api.exeunt.space"

cd "$ROOT"
mkdir -p .release
VITE_API_URL="$API" \
VITE_RPC_KELP_REPLAY="$API/rpc/kelp-replay" \
VITE_RPC_EARN_BANK_RUN="$API/rpc/earn-bank-run" \
  npm run build -w @exeunt/web

# Everything needed to build and run, nothing private or generated.
tar czf "$OUT" \
  --exclude=node_modules --exclude=.git --exclude=.env --exclude='.claude*' --exclude=.release \
  --exclude=brd.md --exclude=CLAUDE.md --exclude=claude.md --exclude=Sample-architecture-nodejs-backend.md \
  --exclude=reports --exclude=contracts/out --exclude=contracts/cache --exclude=contracts/broadcast \
  --exclude=contracts/deployments/local --exclude=apps/backend/data --exclude='*.log' \
  .

"$GCLOUD" compute scp "$OUT" "$VM:/tmp/exeunt-release.tgz" --project "$PROJECT" --zone "$ZONE" --quiet
"$GCLOUD" compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --quiet --command \
  "rm -rf /tmp/exeunt-release && mkdir -p /tmp/exeunt-release && tar xzf /tmp/exeunt-release.tgz -C /tmp/exeunt-release && sudo bash /tmp/exeunt-release/infra/vm/setup.sh"
