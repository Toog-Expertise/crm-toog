# Journal des changements

Les versions suivent la règle « majeure.mineure.correctif ». Chaque version a son étiquette git (`v1.0.0`…), installable avec `sudo ./update.sh v1.0.0`.

## 1.0.1 · 28 octobre 2026

- Installation : si nginx sert déjà un site sur le serveur (un WordPress, par exemple), `install.sh` ajoute le CRM à côté, avec nginx et certbot, au lieu d'installer Caddy. Les autres sites ne sont pas touchés.
- Écrans : les cartes du tableau de bord passent à la ligne sur un écran moyen.

## 1.0.0 · 28 octobre 2026

Première version du CRM commun.

- Connexion Google réservée au domaine de l'entreprise, avec en secours un code par mail. Trois rôles (gérant, accueil, animation), des invitations et la désactivation d'un compte.
- Demandes venues du site (formulaire intégrable, API) et saisies dans le CRM. Tableau par étape, glisser-déposer, filtres par source et par type.
- Contacts et entreprises sans doublon, fusion de fiches, import CSV ou Excel avec aperçu.
- Catalogue avec règles de prix : par personne, forfait, option, sur devis, minimum et maximum, TVA.
- Devis prérempli, PDF à la charte, numérotation continue, envoi par Resend. Devis automatique, avec le prix recalculé par le serveur.
- Signature électronique : lien secret, code par mail, signature au doigt, page de preuve et empreintes SHA-256.
- Paiements Stripe Checkout : acompte, solde, paiement libre, remboursement. Webhook signé et bouton de test à 1 €.
- Relances automatiques et manuelles, écran Relances, horloge de test.
- Tableau de bord avec Google Analytics 4. Agenda synchronisé avec Google Agenda.
- Paramètres : entreprise, logo, couleurs avec contrôle du contraste, polices, accès, devis, modèles de mails, intégrations. Assistant de démarrage.
- Serveur MCP avec un jeton personnel, et des actions sensibles à confirmer dans le CRM.
- RGPD : export, suppression ou anonymisation d'un contact, purge automatique.
- Fichiers d'installation et d'entretien : `install.sh`, `update.sh`, `deploy.sh`, sauvegarde de nuit, contrôle de sécurité.
