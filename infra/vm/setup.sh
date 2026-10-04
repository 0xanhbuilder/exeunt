#!/usr/bin/env bash
# Provisions the Exeunt demo server (Ubuntu 24.04). Run as root from the unpacked release folder:
#   sudo bash infra/vm/setup.sh
# Installs Node 22, Foundry, Caddy and cloudflared, installs the app into /opt/exeunt and enables the services.
# The server holds no private keys: fork nodes use anvil's public test accounts, everything else is read-only.
set -euo pipefail

APP=/opt/exeunt
WEB=/var/www/exeunt
SVC_USER=exeunt
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl git build-essential ca-certificates gnupg rsync debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg > /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q && apt-get install -y -q cloudflared
fi

id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/home/$SVC_USER" --shell /bin/bash "$SVC_USER"
if [ ! -x "/home/$SVC_USER/.foundry/bin/anvil" ]; then
  sudo -u "$SVC_USER" -H bash -c 'curl -fsSL https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup'
fi

# Application code
mkdir -p "$APP" "$WEB/deployments" /var/lib/exeunt /etc/exeunt
rsync -a --delete --exclude node_modules --exclude .env "$SRC/" "$APP/"
# Fork deployment files are written by the seed service; never overwrite or delete them here.
rsync -a --delete --exclude deployments/kelp-replay.json --exclude deployments/earn-bank-run.json "$SRC/apps/web/dist/" "$WEB/"
chown -R "$SVC_USER:$SVC_USER" "$APP" "$WEB" /var/lib/exeunt
sudo -u "$SVC_USER" -H bash -c "cd $APP && npm ci --no-audit --no-fund && npm run build -w @exeunt/sdk -w @exeunt/forkkit -w @exeunt/mcp"
sudo -u "$SVC_USER" -H bash -c "cd $APP/contracts && ~/.foundry/bin/forge build"

# Configuration (kept if already present)
for net in kelp-replay earn-bank-run; do
  [ -f "/etc/exeunt/anvil-$net.env" ] || cp "$SRC/infra/vm/anvil-$net.env" "/etc/exeunt/anvil-$net.env"
done
if [ ! -f /etc/exeunt/backend.env ]; then
  sed "s/__WEBHOOK_SECRET__/$(openssl rand -hex 32)/" "$SRC/infra/vm/backend.env" > /etc/exeunt/backend.env
fi
chmod 640 /etc/exeunt/*.env && chgrp "$SVC_USER" /etc/exeunt/*.env

cp "$SRC"/infra/vm/systemd/* /etc/systemd/system/
cp "$SRC/infra/vm/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now caddy
systemctl restart caddy
systemctl enable exeunt-anvil@kelp-replay exeunt-anvil@earn-bank-run exeunt-seed@kelp-replay exeunt-seed@earn-bank-run
systemctl enable --now exeunt-backend exeunt-refresh-earn.timer exeunt-refresh-kelp.timer
systemctl restart exeunt-backend
# Start (or refresh) both forks and seed them; this takes a few minutes.
systemctl start exeunt-refresh@kelp-replay exeunt-refresh@earn-bank-run --no-block
echo "setup complete"
