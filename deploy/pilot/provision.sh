#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for the Shark Fitness pilot.
#
#   Run as root:  bash provision.sh [--skip-system] <domain>
#
# System part: updates, Docker Engine with the Compose plugin, 2 GB of swap
# (building the image needs more than a 1 GB server has), a firewall that lets
# in only SSH, HTTP and HTTPS, and automatic security updates.
# App part: the data and backup directories, the source checkout, shark.env
# with a fresh SHARK_PASS_SECRET, and the nightly backup timer.
# --skip-system does only the app part; CI uses it on a runner that has Docker.
#
# Safe to run again: nothing that exists is replaced, shark.env included.
set -euo pipefail

skip_system=0
if [ "${1:-}" = "--skip-system" ]; then
  skip_system=1
  shift
fi
domain=${1:?Usage: provision.sh [--skip-system] <domain>}
SHARK_HOME=${SHARK_HOME:-/srv/shark-fitness}
repo=${SHARK_REPO:-https://github.com/amankeshri7542/Shark-Fitness-.git}
[ "$(id -u)" -eq 0 ] || { echo "Run provision.sh as root." >&2; exit 1; }

if [ "$skip_system" -eq 0 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get upgrade -yq
  apt-get install -yq ca-certificates curl git openssl python3 ufw unattended-upgrades

  # Docker's own apt repository, as in docs.docker.com/engine/install/ubuntu.
  if ! command -v docker >/dev/null; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    # shellcheck source=/dev/null
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  if [ -z "$(swapon --noheadings)" ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  # Docker publishes 80 and 443 itself; the app's own port is never published.
  ufw allow OpenSSH
  ufw allow 80/tcp
  ufw allow 443
  ufw --force enable

  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
fi

# The container runs as the image's node user, uid 1000, which owns the data.
install -d -m 755 "$SHARK_HOME"
install -d -m 700 -o 1000 -g 1000 "$SHARK_HOME/data" "$SHARK_HOME/backups"
# Restore drills; copies brought back from off the server go in drill/inbox.
install -d -m 700 "$SHARK_HOME/drill" "$SHARK_HOME/drill/inbox"
[ -d "$SHARK_HOME/src/.git" ] || git clone --quiet "$repo" "$SHARK_HOME/src"
pilot=$SHARK_HOME/src/deploy/pilot

env_file=$SHARK_HOME/shark.env
if [ ! -f "$env_file" ]; then
  secret=$(openssl rand -base64 48 | tr -d '\n')
  (
    umask 077
    sed -e "s|^SHARK_DOMAIN=.*|SHARK_DOMAIN=$domain|" \
        -e "s|^SHARK_PASS_SECRET=.*|SHARK_PASS_SECRET=$secret|" \
        "$pilot/shark.env.example" > "$env_file"
  )
  echo "Wrote $env_file with a new SHARK_PASS_SECRET."
else
  echo "Kept the existing $env_file."
fi
ln -sfn "$env_file" "$pilot/.env"

for unit in shark-backup.service shark-backup.timer; do
  sed "s|/srv/shark-fitness|$SHARK_HOME|g" "$pilot/$unit" > "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now shark-backup.timer

cat <<EOF

Provisioned. Next:
  1. Point the A record for $domain at this server's IPv4 address.
  2. Optionally set alerting values in $env_file (see shark.env.example).
  3. Start the app:        $pilot/deploy.sh
  4. Create the empty gym: $pilot/bootstrap.sh
EOF
