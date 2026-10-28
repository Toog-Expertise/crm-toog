#!/usr/bin/env bash
# CRM Toog : mise à jour sur le serveur. Sauvegarde d'abord, récupère la dernière version, met à jour la base, redémarre.
#   sudo ./update.sh            dernière version de la branche main
#   sudo ./update.sh v1.2.0     une version précise (étiquette git)
# En cas de problème : la sauvegarde faite juste avant est dans backups/ (voir README, « Revenir en arrière »).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="crm"
SERVICE="crm-toog"
TARGET="${1:-}"
cd "$APP_DIR"

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root (sudo ./update.sh)."; exit 1; }

echo "Version actuelle : $(node -p "require('./package.json').version") ($(git rev-parse --short HEAD))"

echo "1/4 · Sauvegarde"
sudo -u "$APP_USER" node --disable-warning=ExperimentalWarning scripts/backup.js

echo "2/4 · Récupération du code"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Des fichiers du dépôt ont été modifiés à la main sur le serveur : mise à jour arrêtée."
  git status --short --untracked-files=no
  exit 1
fi
git fetch --tags --quiet origin
PREVIOUS="$(git rev-parse HEAD)"
if [ -n "$TARGET" ]; then git checkout --quiet "$TARGET"; else git checkout --quiet main && git merge --ff-only --quiet origin/main; fi
echo "Nouvelle version : $(node -p "require('./package.json').version") ($(git rev-parse --short HEAD))"

echo "3/4 · Base de données (migrations automatiques au démarrage) et redémarrage"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" deploy/crm-toog.service > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl restart "$SERVICE"

echo "4/4 · Vérification"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2)"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/sante" >/dev/null 2>&1; then
    echo "✓ À jour et en ligne."
    git log --oneline "$PREVIOUS..HEAD" | head -20
    exit 0
  fi
  sleep 1
done
echo "✗ Le CRM ne répond plus. Retour au code précédent ($PREVIOUS)…"
git checkout --quiet "$PREVIOUS"
systemctl restart "$SERVICE"
echo "Code précédent remis. Si la base pose problème : voir README, « Revenir en arrière ». Journaux : journalctl -u $SERVICE -n 80"
exit 1
