#!/usr/bin/env bash
# CRM Toog : installation sur un VPS Ubuntu neuf (22.04 ou 24.04), en root.
# Installe Node.js 24, le HTTPS (Caddy, ou nginx + certbot si nginx sert déjà d'autres sites),
# le service, la sauvegarde de nuit et le premier gérant.
#
#   git clone git@github.com:Toog-Expertise/crm-toog.git /opt/crm-toog && cd /opt/crm-toog && sudo ./install.sh
#
# Relançable sans risque : ce qui est déjà en place est gardé (base, .env).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_USER="crm"
SERVICE="crm-toog"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local var="$1" q="$2" def="${3:-}"; local v; read -r -p "$q${def:+ [$def]} : " v; printf -v "$var" '%s' "${v:-$def}"; }

[ "$(id -u)" -eq 0 ] || { echo "Lancez ce script en root (sudo ./install.sh)."; exit 1; }
command -v apt-get >/dev/null || { echo "Ce script est prévu pour Ubuntu ou Debian."; exit 1; }

say "1/8 · Les réponses dont j'ai besoin"
ask DOMAIN "Adresse du CRM (ex. crm.mon-entreprise.fr)" "${CRM_DOMAIN:-}"
ask ALLOWED "Domaine autorisé à se connecter (ex. mon-entreprise.fr)" "${CRM_ALLOWED_DOMAIN:-${DOMAIN#*.}}"
ask ADMIN "Adresse du gérant (premier administrateur)" "${CRM_ADMIN_EMAIL:-}"
ask PORT "Port interne du CRM" "${CRM_PORT:-3000}"
[ -n "$DOMAIN" ] && [ -n "$ALLOWED" ] && [ -n "$ADMIN" ] || { echo "Les trois premières réponses sont obligatoires."; exit 1; }

say "2/8 · Vérification du DNS"
IP_PUBLIQUE="$(curl -fsS -4 https://api.ipify.org || true)"
IP_DNS="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
echo "IP du serveur : ${IP_PUBLIQUE:-inconnue} · $DOMAIN pointe vers : ${IP_DNS:-rien}"
if [ -z "$IP_DNS" ] || [ "$IP_DNS" != "$IP_PUBLIQUE" ]; then
  echo "Attention : le DNS de $DOMAIN ne pointe pas (encore) vers ce serveur. Le HTTPS échouera tant que ce n'est pas le cas."
  ask GO "Continuer quand même ? (oui/non)" "non"
  [ "$GO" = "oui" ] || exit 1
fi

# Si nginx sert déjà un site (WordPress…), le CRM s'ajoute à côté, sans toucher aux autres sites
WEB=caddy
if systemctl is-active --quiet nginx; then WEB=nginx; fi
echo "Serveur web : $WEB"

say "3/8 · Paquets système (Node.js 24, HTTPS, sqlite3, rsync)"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync sqlite3 tar >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if [ "$WEB" = nginx ]; then
  command -v certbot >/dev/null || apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
elif ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "Node $(node -v) · $([ "$WEB" = nginx ] && nginx -v 2>&1 | cut -d' ' -f3 || caddy version | cut -d' ' -f1)"

say "4/8 · Utilisateur système et droits"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data" "$APP_DIR/backups"

say "5/8 · Le fichier .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
  sed -i \
    -e "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" \
    -e "s#^PORT=.*#PORT=$PORT#" \
    -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SECRET#" \
    -e "s#^ADMIN_EMAIL=.*#ADMIN_EMAIL=$ADMIN#" \
    -e "s#^ALLOWED_DOMAIN=.*#ALLOWED_DOMAIN=$ALLOWED#" \
    "$APP_DIR/.env"
  echo ".env créé. Les clés (Google, Stripe, Resend…) se collent dedans plus tard : nano $APP_DIR/.env"
else
  echo ".env déjà présent : gardé tel quel."
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/backups" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
chmod 700 "$APP_DIR/data" "$APP_DIR/backups"

say "6/8 · La base et le premier gérant"
sudo -u "$APP_USER" node --disable-warning=ExperimentalWarning "$APP_DIR/scripts/admin.js" "$ADMIN"

say "7/8 · Le service, le HTTPS et la sauvegarde de nuit"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" "$APP_DIR/deploy/crm-toog.service" > "/etc/systemd/system/$SERVICE.service"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__USER__#$APP_USER#g" "$APP_DIR/deploy/crm-toog-backup.service" > "/etc/systemd/system/$SERVICE-backup.service"
cp "$APP_DIR/deploy/crm-toog-backup.timer" "/etc/systemd/system/$SERVICE-backup.timer"
systemctl daemon-reload
systemctl enable --now "$SERVICE" "$SERVICE-backup.timer" >/dev/null
if [ "$WEB" = nginx ]; then
  sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" "$APP_DIR/deploy/nginx.conf" > "/etc/nginx/sites-available/$SERVICE.conf"
  ln -sf "/etc/nginx/sites-available/$SERVICE.conf" "/etc/nginx/sites-enabled/$SERVICE.conf"
  nginx -t && systemctl reload nginx
  # Certificat Let's Encrypt pour ce seul domaine (les autres sites ne bougent pas)
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN" --redirect || echo "Le certificat n'a pas pu être créé (DNS pas encore propagé ?) : relancez sudo certbot --nginx -d $DOMAIN"
else
  mkdir -p /etc/caddy/sites
  sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" "$APP_DIR/deploy/Caddyfile" > "/etc/caddy/sites/$SERVICE.caddy"
  grep -q 'import sites/\*' /etc/caddy/Caddyfile 2>/dev/null || printf '\nimport sites/*\n' >> /etc/caddy/Caddyfile
  # Le Caddyfile par défaut sert une page sur le port 80 : on la retire si elle est encore là
  sed -i '/^:80 {/,/^}/d' /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi

say "8/8 · Vérification"
sleep 3
if curl -fsS "http://127.0.0.1:$PORT/sante" >/dev/null; then echo "✓ Le CRM répond sur le serveur."; else echo "✗ Le CRM ne répond pas : journalctl -u $SERVICE -n 50"; fi
if curl -fsS "https://$DOMAIN/sante" >/dev/null 2>&1; then echo "✓ HTTPS actif : https://$DOMAIN"; else echo "… HTTPS pas encore prêt (certificat en cours, ou DNS) : réessayez dans une minute, curl https://$DOMAIN/sante"; fi

cat <<EOF

C'est installé.
  1. Ouvrez https://$DOMAIN et connectez-vous avec $ADMIN (code par mail tant que Google n'est pas branché :
     sans Resend, le code s'affiche dans les journaux : journalctl -u $SERVICE -n 30).
  2. L'assistant de démarrage s'ouvre : nom, logo, couleurs, domaine autorisé, prix.
  3. Branchez Google, Resend et Stripe (mode test) en suivant le README, puis : sudo systemctl restart $SERVICE
Journaux : journalctl -u $SERVICE -f · Mise à jour : sudo ./update.sh · Contrôle : sudo -u $APP_USER npm run check
EOF
