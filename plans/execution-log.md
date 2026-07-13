# Journal d’exécution des plans

Branche : `codex/execute-untracked-plans`.

## Plan 009 — terminé

- Retrait complet de l’export HTML du CLI, du navigateur, des requêtes de
  révision, de la CI et de la documentation active.
- Commits : `4dd0434`, `c3e5869`, `5ba101f`, `6545e62`.
- Vérifications : tests ciblés CLI/web/report, vérification de types, build,
  et test navigateur ciblé d’hydratation.
- Note : la route racine reste eager. La supprimer du point d’entrée rendait
  l’application servie non hydratée ; le test Playwright de persistance d’URL
  redevient vert avec cette contrainte.

## Plan 010 — en cours

- Le smoke de production lance directement `node start.mjs`, borne chaque phase,
  attend les drains de logs et vérifie que le port est réutilisable.
- Tests CLI réels ajoutés pour machine, étiquette, snapshot, merge JSON/CSV et
  rejet de `--html`, dans un profil et un répertoire de travail temporaires.
- Commits : `a4a237b`, `1260816`, `e64a222`.
