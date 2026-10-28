#!/usr/bin/env bash
# CRM Toog : déploiement en une commande, depuis votre ordinateur.
# Envoie le code sur GitHub, puis lance update.sh sur le serveur (qui récupère le code depuis GitHub).
#   ./deploy.sh                      serveur de DEPLOY_HOST (ou « crm » par défaut, alias SSH)
#   DEPLOY_HOST=vps ./deploy.sh      un autre alias SSH
#   DEPLOY_DIR=/opt/crm-toog         dossier du CRM sur le serveur
set -euo pipefail

HOST="${DEPLOY_HOST:-crm}"
DIR="${DEPLOY_DIR:-/opt/crm-toog}"
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "Des changements ne sont pas enregistrés (commit) :"
  git status --short
  exit 1
fi
echo "Tests…"
npm test --silent >/dev/null 2>&1 || { echo "Les tests échouent : déploiement arrêté (npm test pour voir)."; exit 1; }
echo "Envoi sur GitHub…"
git push --quiet origin HEAD:main
git push --quiet --tags origin
echo "Mise à jour du serveur $HOST…"
ssh "$HOST" "cd $DIR && sudo ./update.sh"
