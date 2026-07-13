# Journal d’exécution des plans

## Clôture du programme 009 à 020 — 2026-07-14

- Branche dédiée : `codex/execute-untracked-plans`.
- Point de départ du programme : `17bcf28`.
- Tous les plans auparavant non suivis de 010 à 020 sont maintenant présents
  dans ce répertoire, exécutés dans leur ordre de dépendance et marqués `DONE`.
- Le plan 009, déjà présent, a également été terminé sur cette branche avant les
  plans non suivis.

## Résultats par plan

| Plan | Résultat livré | Commits principaux |
| --- | --- | --- |
| 009 | Suppression complète de l’export HTML dans le CLI, le web, les requêtes, la CI et les docs actives. | `4dd0434`, `c3e5869`, `5ba101f`, `6545e62` |
| 010 | Smoke de production borné avec nettoyage du processus propriétaire ; intégrations CLI réelles et isolées. | `a4a237b`, `1260816`, `e64a222`, `1f11401`, `ffc7146`, `3bb577c` |
| 011 | Identité machine atomique, écritures concurrentes sérialisées et état privé propriétaire. | `ee86517`, `77ce626`, `7bb9ba1` |
| 012 | Lectures d’historique bornées/no-follow, snapshots SQLite cohérents avec WAL et caches sensibles au WAL. | `a4bcf22`, `75940d5` |
| 013 | Validation runtime des métriques avant toute agrégation. | `735c47d` |
| 014 | Limites portables symétriques et workflow preview/confirm lié aux octets et à la génération du store. | `d711d17`, `f815903` |
| 015 | Provenance portable opaque, sans résolution ni autorité filesystem locale. | `6975445` |
| 016 | Un runner exact-révision et un cycle de processus commun pour les six requêtes Focused/Session. | `fd000b0` |
| 017 | Génération sémantique, assemblage pur unique, capture `changed/unchanged`, no-op sans assemblage ni publication, renouvellement privé sans rematérialiser SQLite. | `de847d8`, `89edf9f` |
| 018 | Un propriétaire navigateur unique pour acquisition, retry d’expiration, supersession et commit atomique des destinations. | `dbd1fe2` |
| 019 | Identité de cible revalidée sous verrou, création sûre des parents et cas d’usage Skills derrière une façade applicative profonde. | `61f45d9` |
| 020 | Hook réellement staged-only, Bun 1.3.13 aligné, résidu CSV supprimé et documentation réconciliée. | `01cd39e` |

Les décisions conditionnelles du plan 016 et les preuves spécifiques du plan
020 sont détaillées dans leurs journaux voisins.

## Preuves finales

Exécutées sur la branche dédiée après les changements fonctionnels :

- `bun x ultracite check` : succès, 355 fichiers, aucun correctif requis ;
- `bun run lint` : succès ;
- `bun run typecheck` : 16 tâches sur 16 ;
- `bun run test` : 600 tests de packages et 8 tests d’outillage, aucun échec ;
- `bun run build` : 9 tâches sur 9 ;
- `CI=1 bun run test:e2e` : 32 scénarios sur 32 ;
- `CI=1 bun run test:e2e-production` : 4 scénarios sur 4 ;
- `bun install --frozen-lockfile` : succès avec Bun 1.3.13, sans dérive du lockfile.

Les seuls messages non bloquants sont les avertissements Playwright/Bun sur la
combinaison `NO_COLOR` et `FORCE_COLOR`.
