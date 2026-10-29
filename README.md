# CRM Toog

Le CRM commun de Toog Expertise pour les établissements de loisirs, d'événementiel et de services : les demandes, les devis, la signature électronique, les paiements, les relances et le tableau de bord, au même endroit.

Chaque entreprise installe sa propre copie sur son serveur, puis règle dans le CRM son nom, son logo, ses couleurs et ses prix. Le dépôt ne contient aucune donnée d'entreprise ni aucune clé.

**Le dépôt de référence.** Tout le monde part de ce dépôt, pour avoir exactement la même interface : sur GitHub, **Use this template › Create a new repository** (privé, à votre nom, par exemple `crm-mon-entreprise`). Les couleurs par défaut sont neutres (bleu, fond clair). Pour mettre le CRM à vos couleurs, en deux minutes : **Paramètres › Logo et couleurs** (le contraste est vérifié, une couleur illisible est refusée).

## Ce que fait le CRM

Un CRM d'automatisation commerciale **B2B** : le client remplit un formulaire, reçoit son devis, le valide, paie l'acompte, et tout se suit dans le CRM.

- **Connexion** par adresse mail et mot de passe. Le gérant crée les comptes de l'équipe (prénom, nom, mail, mot de passe) ; tout le monde a tous les droits. Google reste une option (désactivée par défaut).
- **Accueil** : 3 chiffres (demandes reçues, devis signés, taux de signature), cette semaine (du lundi au dimanche) ou ce mois-ci.
- **Devis** : demandes et devis sur une seule page, en liste ou en Kanban, avec le montant de chaque colonne. Les étapes : Demande, Devis envoyé, Relance email, Relance téléphonique, Signé, Acompte payé, Réalisé, Soldé. Un post-it par demande.
- **Nouveau devis manuel** : les activités du catalogue, les prix HT et TTC, l'acompte fixe ou en %, avec ou sans lien de paiement. En option, la fiche entreprise remplie depuis la base Sirene de l'INSEE.
- **Formulaire du site** (devis automatique) : 4 étapes avec une jauge, « Recevoir mon devis », le devis reçu tout de suite.
- **Une page pour le client** : le devis à gauche ; à droite, 1. je valide (prénom, nom, « bon pour accord » écrit), 2. je paie l'acompte ; le contact de l'établissement avec sa photo, et la plaquette. PDF validé avec une page de preuve et les empreintes SHA-256.
- **Paiements en tiroirs** : virement classique (le gérant passe le devis en « Acompte payé » après avoir vérifié sa banque), Stripe (carte, et virement vers un IBAN propre au client que Stripe suit ; le webhook passe le devis en « Acompte payé » avec le montant), Pennylane (module à part). Export comptable en CSV.
- **Mails auto** (Resend) : envoi du devis (avec le lien de la plaquette dans le texte), 2 relances de signature, 2 relances d'acompte, merci à M+3, « il y a un an » à M+12. Chacun : actif ou non, délai, texte modifiable, envoi de test. Tout s'arrête dès que le client valide, paie ou répond.
- **Paramètres** : identité et mentions légales du devis, numérotation (qui peut reprendre à un numéro choisi), acompte par défaut, moyens de paiement, logo et couleurs.
- **Pour aller plus loin** (montré, pas au programme) : messages reçus, contacts, liste des paiements, agenda, MCP et API pour brancher Claude ou d'autres outils.
- **RGPD** : export et suppression des données d'un contact, purge automatique après 3 ans sans activité (durée réglable).

Côté technique : Node.js 22 ou plus récent, et la base SQLite intégrée à Node. Le CRM n'a **aucune dépendance**, donc pas de `npm install` et presque rien à mettre à jour.

---

## Ce qu'il faut avant de commencer

| Quoi | Pour quoi | Coût |
|---|---|---|
| Un VPS Ubuntu 22.04 ou 24.04 (1 Go de RAM suffit), accès root en SSH | faire tourner le CRM | quelques € par mois |
| Un domaine, et l'accès à sa zone DNS | l'adresse du CRM, par exemple `crm.mon-entreprise.fr` | déjà payé |
| Un accès en lecture au dépôt `Toog-Expertise/crm-toog` | récupérer le code | — |
| Google Workspace (conseillé) | la connexion Google réservée à l'entreprise | abonnement existant |
| Un compte Google Cloud (le même compte administrateur) | connexion, Analytics, Agenda | gratuit |
| Un compte Resend et un sous-domaine d'envoi (par exemple `notif.mon-entreprise.fr`) | les mails | gratuit jusqu'à 3 000 mails par mois |
| Un compte Stripe | les paiements (en mode test pour commencer) | commission par paiement |
| Un compte Cloudflare (facultatif) | Turnstile, l'anti-spam des formulaires | gratuit |

Sans Google Workspace, la connexion se fait par code envoyé par mail. Sans Resend, le CRM fonctionne aussi, mais les mails sont seulement « simulés » : ils sont notés dans l'historique et affichés dans les journaux du serveur.

---

## Installation pas à pas

### 1. Le DNS (à faire la veille)

Chez le gestionnaire du domaine, ajoutez un enregistrement **A** : nom `crm` (ou `crm.sous-domaine`), valeur = l'adresse IP du VPS, TTL 3600.

Pour vérifier, depuis votre ordinateur : `dig +short crm.mon-entreprise.fr` doit afficher l'IP du VPS.

### 2. L'accès du serveur au dépôt (clé de déploiement en lecture seule)

Sur le VPS, en root :

```bash
ssh-keygen -t ed25519 -f /root/.ssh/crm_deploy -N "" -C "crm-$(hostname)"
cat /root/.ssh/crm_deploy.pub
```

Sur GitHub : dépôt `crm-toog` › Settings › Deploy keys › Add deploy key › collez la clé affichée et **ne cochez pas** « Allow write access » › Add key.

Si le dépôt appartient à Toog Expertise, demandez à Toog d'ajouter la clé, ou de vous ajouter comme collaborateur en lecture.

### 3. Le code

```bash
GIT_SSH_COMMAND="ssh -i /root/.ssh/crm_deploy -o StrictHostKeyChecking=accept-new" git clone git@github.com:Toog-Expertise/crm-toog.git /opt/crm-toog
cd /opt/crm-toog
git config core.sshCommand "ssh -i /root/.ssh/crm_deploy"
```

### 4. L'installation

```bash
sudo ./install.sh
```

Le script vous demande l'adresse du CRM, le domaine autorisé et l'adresse du gérant. Il installe ensuite, dans l'ordre :

- Node.js 24 ;
- Caddy, qui gère le HTTPS gratuit et automatique (ou nginx et certbot, si nginx est déjà là) ;
- un utilisateur système `crm` ;
- le fichier `.env`, avec un secret de session généré ;
- la base vide et le premier gérant ;
- le service `crm-toog`, qui redémarre tout seul ;
- la sauvegarde de chaque nuit à 3 h.

Le script peut être relancé sans risque : il garde le `.env` et la base existants.

Si nginx sert déjà un site sur le serveur (un WordPress, par exemple), le script s'en sert au lieu d'installer Caddy. Il ajoute alors le CRM comme un site de plus, avec son propre certificat (certbot), sans toucher aux autres sites.

### 5. La première connexion

À la fin de `install.sh`, le **mot de passe provisoire** du gérant s'affiche (une seule fois). Ouvrez `https://crm.mon-entreprise.fr`, connectez-vous avec l'adresse du gérant et ce mot de passe, puis changez-le dans **Mon compte**.

Mot de passe perdu par le gérant ? Sur le serveur :

```bash
sudo -u crm node --disable-warning=ExperimentalWarning /opt/crm-toog/scripts/admin.js gerant@mon-entreprise.fr "Prénom Nom"
```

Puis remplissez **Paramètres** : identité et mentions légales, devis (numérotation, acompte), paiements, logo et couleurs. Ajoutez l'équipe dans **Équipe**.

### 6. Les intégrations, une à une

Les clés se collent **uniquement dans le fichier `.env` du serveur**, jamais dans une conversation ni sur GitHub. Pour ouvrir le fichier :

```bash
sudo nano /opt/crm-toog/.env
```

Après chaque modification, redémarrez le service :

```bash
sudo systemctl restart crm-toog
```

L'état de chaque intégration s'affiche dans **Paramètres › Intégrations**, avec les adresses exactes à recopier.

#### Google : la connexion

1. Sur console.cloud.google.com, ouvrez le sélecteur de projet, puis **Nouveau projet** : nom « CRM Mon entreprise », puis **Créer**.
2. **Google Auth Platform** (ou « Écran de consentement OAuth ») › **Commencer** : saisissez le nom de l'application et l'adresse d'assistance, choisissez le type d'audience **Interne**, puis **Créer**.
3. **Clients** › **Créer un client** › type **Application Web** › **URI de redirection autorisés** : `https://crm.mon-entreprise.fr/auth/google/callback`.
4. Copiez l'ID client et le code secret dans le `.env`, sous `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET`.

Seules les adresses vérifiées du domaine autorisé, et invitées depuis l'écran **Équipe**, peuvent entrer. Le contrôle se fait sur le serveur.

#### Resend : les mails

1. Sur resend.com, ouvrez **Domains** › **Add domain** : saisissez `notif.mon-entreprise.fr`, région Europe. Ajoutez dans le DNS les enregistrements affichés (MX, SPF, DKIM), puis cliquez sur **Verify**.
2. **API Keys** › **Create API key** : permission « Sending access », limitée au domaine `notif.`. Copiez la clé dans `RESEND_API_KEY`.
3. Dans le `.env`, renseignez aussi l'expéditeur et l'adresse de réponse :
   - `MAIL_FROM=Mon Entreprise <devis@notif.mon-entreprise.fr>`
   - `MAIL_REPLY_TO=contact@mon-entreprise.fr`
4. **Webhooks** › **Add endpoint** : URL `https://crm.mon-entreprise.fr/api/resend/webhook`, événements `email.sent`, `email.delivered`, `email.opened`, `email.bounced`, `email.complained`. Copiez le secret de signature dans `RESEND_WEBHOOK_SECRET`.

Pour vérifier : **Paramètres › Mails et relances** › un modèle › « M'envoyer un test ».

#### Stripe : les paiements, en mode test d'abord

1. Sur stripe.com, créez le compte de l'entreprise. Vous arrivez en mode test (« sandbox »).
2. **Développeurs** › **Clés API** :
   - la clé publiable `pk_test_…` va dans `STRIPE_PUBLISHABLE_KEY` ;
   - créez une **clé secrète restreinte** avec les droits Checkout Sessions, PaymentIntents et Refunds en écriture, Balance en lecture. Elle va dans `STRIPE_SECRET_KEY`.
3. **Développeurs** › **Webhooks** › **Ajouter une destination** : URL `https://crm.mon-entreprise.fr/api/stripe/webhook`, événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `payment_intent.payment_failed`, `charge.refunded`. Copiez le secret `whsec_…` dans `STRIPE_WEBHOOK_SECRET`.
4. Dans **Paramètres › Devis et paiements**, cliquez sur « Tester » : un paiement de 1 € s'ouvre. Payez avec la carte de test 4242 4242 4242 4242, une date future et n'importe quel code.

Pour passer en réel : le gérant active le compte Stripe (informations de l'entreprise, SIRET, pièce d'identité, IBAN). Ensuite, on remplace les clés de test par les clés réelles dans le `.env` et on recrée le webhook en mode réel.

#### La boîte de réception (écran Messages)

Les réponses des clients arrivent dans le CRM, rangées avec leur demande.

1. Sur resend.com, ouvrez **Domains**, choisissez le domaine `notif.mon-entreprise.fr` et activez la **réception** (« Receiving »). Ajoutez dans le DNS l'enregistrement MX affiché.
2. Dans le `.env`, indiquez l'adresse qui recevra les réponses : `MAIL_INBOUND=reponses@notif.mon-entreprise.fr`.
3. Dans le webhook Resend (voir plus haut), cochez aussi l'événement `email.received`.

Chaque mail envoyé à un client porte une adresse de réponse propre à sa demande (`reponses+123@…`) : sa réponse se range toute seule dans la bonne conversation. Un expéditeur inconnu apparaît aussi dans **Messages** : un clic le transforme en demande.

Pour recevoir aussi les mails envoyés à votre adresse de contact habituelle, ajoutez un transfert automatique de cette boîte vers l'adresse `MAIL_INBOUND`.

#### Google Analytics et Google Agenda (compte de service)

1. Dans le projet Google Cloud, ouvrez **API et services** › **Bibliothèque** et activez **Google Analytics Data API** et **Google Calendar API**.
2. **IAM et administration** › **Comptes de service** › **Créer** : nom « crm ». Dans le compte créé, ouvrez **Clés** › **Ajouter une clé** › **JSON**. Un fichier est téléchargé.
3. Encodez ce fichier sur une ligne, puis collez le résultat dans `GOOGLE_SERVICE_ACCOUNT_JSON` :

   ```bash
   base64 -i cle.json | tr -d '\n'
   ```

   Supprimez ensuite le fichier JSON de votre ordinateur.
4. Pour Analytics : dans analytics.google.com, ouvrez **Administration** › **Gestion des accès à la propriété**, et ajoutez l'adresse du compte de service (`…@….iam.gserviceaccount.com`) avec le rôle **Lecteur**. Recopiez l'ID de la propriété (un nombre) dans `GA4_PROPERTY_ID`.
5. Pour l'agenda : créez un agenda « Réservations ». Dans ses paramètres, ouvrez **Partager avec des personnes** et ajoutez le compte de service avec le droit **Modifier les événements**. Collez l'ID de l'agenda dans **Paramètres › Formulaire et site**.

Les chiffres d'Analytics sont mis en cache une heure. Une réservation entre dans l'agenda quand son acompte est payé.

#### Le formulaire du site et le devis automatique

- Dans **Paramètres › Formulaire et site**, indiquez l'adresse du site : c'est elle qui autorise l'affichage du formulaire dans vos pages.
- Copiez ensuite le code proposé dans la page voulue (WordPress : un bloc « HTML personnalisé »), par exemple :

  ```html
  <script src="https://crm.mon-entreprise.fr/embed.js" data-crm="formulaire" data-type="anniversaire"></script>
  <script src="https://crm.mon-entreprise.fr/embed.js" data-crm="devis"></script>
  ```

- Contre le spam, le formulaire a déjà une case invisible, un délai minimum et une limite d'envois par minute. Pour ajouter Turnstile : dash.cloudflare.com › Turnstile › Ajouter un widget, avec le nom d'hôte du CRM et le mode « Géré ». Les deux clés vont dans `TURNSTILE_SITE_KEY` et `TURNSTILE_SECRET_KEY`.
- Votre site a déjà ses propres formulaires ? Il peut envoyer les demandes par API, avec la clé `SITE_API_KEY` :

  ```bash
  curl -X POST https://crm.mon-entreprise.fr/api/public/demandes \
    -H "Content-Type: application/json" -H "X-Api-Key: $SITE_API_KEY" \
    -d '{"type":"entreprise","name":"Nom Prénom","email":"client@exemple.fr","phone":"0600000000","people":20,"event_at":"2026-12-04T18:00","message":"…","data":{"societe":"Société"}}'
  ```

#### MCP et API : brancher Claude ou d'autres outils

Dans le CRM, ouvrez **Paramètres › Intégrations** (ou **Mon compte**) › **Créer un jeton**. Le jeton a les droits de la personne qui le crée.

- **Claude** : dans Claude, ouvrez **Paramètres** › **Connecteurs** › **Ajouter un connecteur personnalisé** et collez l'adresse affichée (`https://crm…/mcp/crm_…`).
- **Un autre outil** (logiciel de caisse, Zapier, Make, tableur) : il appelle l'API `https://crm…/api/…` avec l'en-tête `Authorization: Bearer <jeton>`. Les adresses principales sont listées dans **Paramètres › Intégrations**.

Depuis Claude, le CRM permet ceci :

- lire les demandes, les messages à traiter, les devis, les paiements et les chiffres ;
- préparer un devis (en brouillon) ou une relance (en pause, à réactiver dans le CRM).

Il ne peut pas envoyer, rembourser ou supprimer : ces actions apparaissent dans **Accueil › À confirmer**, où une personne de l'équipe les confirme.

---

## Au quotidien

| Pour… | Commande (sur le serveur, dans `/opt/crm-toog`) |
|---|---|
| Voir les journaux | `journalctl -u crm-toog -f` |
| Mettre à jour | `sudo ./update.sh` (sauvegarde d'abord, revient tout seul en arrière si le CRM ne redémarre pas) |
| Installer une version précise | `sudo ./update.sh v1.0.0` |
| Faire une sauvegarde | `sudo -u crm npm run backup` |
| Vérifier la dernière sauvegarde | `sudo -u crm npm run backup -- --verifier` (restaure sur une copie, vérifie, supprime la copie) |
| Contrôle de sécurité et d'entretien | `sudo npm run check` |
| Remettre un gérant | `sudo -u crm npm run admin -- gerant@mon-entreprise.fr "Prénom Nom"` |

Les sauvegardes sont dans `backups/`, et les 14 dernières sont gardées. Pour copier chaque sauvegarde **hors du serveur**, renseignez `BACKUP_REMOTE` dans le `.env` (par exemple `sauvegarde@autre-serveur:/sauvegardes/crm`) et donnez à l'utilisateur `crm` une clé SSH vers ce serveur.

### Revenir en arrière

```bash
sudo systemctl stop crm-toog
cd /opt/crm-toog && sudo -u crm mkdir -p /tmp/restauration
sudo tar -xzf backups/crm-AAAAMMJJ-HHMM.tar.gz -C /tmp/restauration
sudo cp -a data data.avant-restauration
sudo cp /tmp/restauration/crm.db data/crm.db && sudo cp -r /tmp/restauration/uploads /tmp/restauration/pdf data/ 2>/dev/null || true
sudo rm -f data/crm.db-wal data/crm.db-shm && sudo chown -R crm:crm data
sudo git checkout v1.0.0   # la version d'avant, si besoin
sudo systemctl start crm-toog
```

### Déployer depuis son ordinateur

Si vous modifiez le CRM, `./deploy.sh` lance les tests, envoie le code sur GitHub, puis met à jour le serveur. Le serveur est l'alias SSH `crm` par défaut, ou celui de `DEPLOY_HOST`.

### Avant la vraie mise en service

1. Retirez les données d'exemple : `sudo -u crm npm run demo -- --supprimer`. Pour les données de test créées à la main, supprimez-les dans le CRM.
2. Réglez le domaine autorisé sur celui de l'entreprise (**Paramètres › Accès**).
3. Passez Stripe en mode réel (voir plus haut).
4. Lancez `sudo npm run check` : tout doit être vert.

---

## Pour développer

```bash
git clone git@github.com:Toog-Expertise/crm-toog.git && cd crm-toog
cp .env.example .env     # APP_URL=http://localhost:3000, NODE_ENV=development, ALLOWED_DOMAIN, ADMIN_EMAIL
npm run demo             # données d'exemple, toutes marquées TEST
npm run dev              # http://localhost:3000 ; les codes de connexion s'affichent dans le terminal
npm test                 # tests automatiques (parcours complet sur une base jetable)
```

### Organisation du code

- `server.js` : le point d'entrée, les en-têtes de sécurité et la protection contre les requêtes venues d'un autre site.
- `src/` : un fichier par sujet.
  - `db.js` : la base et ses migrations ;
  - `auth.js` : la connexion ;
  - `deals.js`, `quotes.js`, `pdf.js` et `sign.js` : les demandes, les devis, les PDF et la signature ;
  - `payments.js` : Stripe, virement et export comptable ;
  - `sirene.js` : la fiche entreprise depuis la base Sirene ;
  - `mail.js` : Resend ;
  - `reminders.js` : les relances ;
  - `analytics.js`, `calendar.js` et `google.js` : Analytics, l'agenda et le compte de service ;
  - `mcp.js` : le serveur MCP ;
  - `rgpd.js` : l'export, la suppression et la purge ;
  - `api.js` et `public.js` : l'API des écrans et les pages publiques.
- `public/` : les écrans, sans framework. Les couleurs viennent de `/theme.css`, généré à partir des paramètres.
- `scripts/` : l'administration, la sauvegarde, le contrôle et les données d'exemple.
- `deploy/` : le service systemd, la sauvegarde de nuit et la configuration de Caddy.

### Règles du dépôt

- Aucune clé dans le code : `npm run check` le vérifie, historique git compris.
- Aucune donnée d'entreprise : les couleurs, le logo, les prix et les textes se règlent dans le CRM.
- Une modification de la base = une migration ajoutée à la fin de `MIGRATIONS` dans `src/db.js`, jamais une migration modifiée.
- Chaque version : le numéro dans `package.json`, une entrée dans `CHANGELOG.md` et une étiquette git `vX.Y.Z`.
