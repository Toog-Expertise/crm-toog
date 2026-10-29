# Journal des changements

Les versions suivent la règle « majeure.mineure.correctif ». Chaque version a son étiquette git (`v1.0.0`…), installable avec `sudo ./update.sh v1.0.0`.

## 1.4.0 · 29 octobre 2026

- Paramètres › Intégrations regroupe tout ce qui se branche : l'état des services (Stripe, Resend, Turnstile, site…), les adresses à recopier, l'option INSEE, et la partie API et MCP (jetons, adresse MCP pour Claude, adresses de l'API) pour connecter d'autres outils. L'ancien onglet « MCP et API » y renvoie.
- Le mail d'envoi du devis donne le paiement choisi par le dirigeant pour ce devis : le bouton « Payer l'acompte » (paiement en ligne, juste après la validation) et/ou l'IBAN avec la référence. Nouvelle variable {{paiement}} ; la ligne disparaît s'il n'y a rien à payer.
- MCP : la liste des étapes de l'outil lister_demandes suit les étapes de la version B2B.

## 1.3.1 · 28 octobre 2026

- Page du client : pour valider, seulement le prénom, le nom et « bon pour accord » écrit. L'entreprise est reprise de la demande (PDF et page de preuve) ; le poste n'est plus demandé.
- L'initiale du contact s'affiche dans son rond quand il n'y a pas de photo.

## 1.3.0 · 28 octobre 2026 · version B2B (décisions du 28/10 avec Benjamin)

- B2B uniquement : types de demande entreprise, CSE, association ; plus de relance d'avis Google ni de règles B2C.
- Menu : Accueil, Devis, Mails auto, Équipe, Paramètres en bas ; « Pour aller plus loin » (messages, contacts, paiements, agenda, MCP et API) à montrer seulement.
- Accueil : 3 chiffres (demandes reçues, devis signés, taux de signature), cette semaine (lundi → dimanche) ou ce mois-ci.
- Devis : demandes et devis sur une seule page, vue liste ou Kanban, montant par colonne, actions sur chaque ligne (voir, renvoyer, lien), post-it. Étapes : Demande, Devis envoyé, Relance email, Relance téléphonique, Signé, Acompte payé, Réalisé, Soldé.
- Nouveau devis manuel : activités du catalogue, HT et TTC, acompte fixe ou en %, avec ou sans lien de paiement. Recherche INSEE en option (Paramètres › Intégrations).
- Une seule page pour le client : le devis à gauche, à droite 1. je valide (prénom, nom, « bon pour accord » écrit), 2. je paie l'acompte ; le contact de l'établissement avec sa photo, la plaquette.
- Paiements en tiroirs : virement classique (passage à « Acompte payé » à la main), Stripe (carte et virement vers un IBAN suivi par Stripe, webhook), Pennylane annoncé (module à part).
- Mails auto : envoi du devis (avec le lien de la plaquette dans le texte), 2 relances signature, 2 relances acompte, M+3, M+12 ; actif ou non, délai, texte, test.
- Équipe : prénom, nom, mail, mot de passe choisi par le gérant ; connexion par mail et mot de passe ; tout le monde a tous les droits. Google reste une option désactivée.
- Paramètres : identité et mentions légales (forme juridique, capital, RCS…), numérotation qui reprend à un numéro choisi, acompte par défaut fixe ou en %.
- Aligné sur les écrans montrés le 28/10 (prototype de Benjamin, PlayPro, Privacy Escape) : page Devis avec réf., client · événement, paiement et « prochaine action auto » (bouton « Valider l'acompte reçu »), étapes en pastilles, export CSV ; Mails auto en parcours (Signature, Acompte, Fidélisation) avec déclencheur, règle d'arrêt, chiffres et aperçu ; « Demander un acompte » sous le total TTC ; page client « On a hâte de vous accueillir » avec 3 points forts ; recherche d'entreprise (option) dans le formulaire du site ; règles d'arrêt M+3 et M+12.
- Responsive : page Devis en cartes sur téléphone, chiffres sur une ligne, étapes qui défilent, résumé du devis en tête de la page client.

## 1.2.0 · 28 octobre 2026

- Accueil : valeur du pipe, délai moyen entre l'envoi du devis et le paiement de l'acompte (délais de plus de 30 jours exclus), dernières demandes et derniers devis en direct (mise à jour toutes les 30 secondes). Montant de chaque colonne dans le tableau des demandes.
- Nouvelle demande : choix de l'activité du catalogue (elle fait la première ligne du devis) en plus du type.
- Relances : 2 mails pour la signature et 2 pour l'acompte, avec un modèle différent pour la 2e ; remerciement à M+3 et « il y a un an » à M+12 avec une réduction réglable (10 % par défaut). Les relances commerciales ne visent que les entreprises et associations (réglable). Appels notés sur la fiche ; colonne « Relances » dans la liste des devis.
- Mail du devis : lien de la plaquette (Google Drive), facultatif.
- Paiements : virement (IBAN vérifié, page de paiement au choix carte ou virement, règlement écrit sur le devis), encaissement noté à la main (virement, espèces, chèque), export comptable CSV, acompte propre à une prestation du catalogue. Nouvel onglet Paramètres › Paiements.
- Entreprises : fiche remplie depuis la base Sirene (nom ou SIRET).

## 1.1.0 · 28 octobre 2026

- Messages : les mails des clients arrivent dans le CRM (réception Resend), rangés avec leur demande ; on y répond depuis le CRM. Une réponse du client arrête ses relances. Bouton « Écrire au client » sur chaque demande.
- Paramètres › MCP et API : jetons personnels pour Claude (MCP) et pour l'API, avec les droits de la personne, et la liste des adresses utiles pour brancher d'autres outils.
- Connexion : lien direct dans le mail du code.

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
