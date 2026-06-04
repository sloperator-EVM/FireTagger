#!/usr/bin/env bash
set -euo pipefail
if ! command -v pacman >/dev/null 2>&1; then
  printf 'This setup script is for Arch Linux. Install Arch Linux on the VM, then rerun it.\n' >&2
  exit 1
fi
sudo pacman -Syu --needed --noconfirm docker docker-compose docker-buildx git curl ufw caddy
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo systemctl enable --now ufw
printf 'Arch Linux setup complete. Log out and SSH back in before running Docker commands.\n'
