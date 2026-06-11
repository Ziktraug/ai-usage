# Report App Plan

## Etat actuel

La stack est en place sous forme de monorepo Bun/Turbo :

- `apps/cli` : CLI existante déplacée et adaptée.
- `apps/report` : app HTML SolidJS + TanStack Router + Panda CSS + Ark UI + Vite single-file.
- `packages/usage-core` : modèle, analytics, pricing, préparation des données de report.
- `packages/local-collectors` : collecte locale Codex / Claude / OpenCode / Cursor.

Le flag CLI `--html` existe et génère un fichier HTML single-file à partir de `apps/report/dist/index.html`, avec injection de `window.__AI_USAGE_REPORT__`.

Le serveur de dev report tourne sur :

```sh
http://127.0.0.1:5173/
```

## Bug corrige

Le rendu initial était quasiment brut parce que Panda CSS ne produisait pas de CSS utilisable dans le bundle.

Cause exacte :

- `apps/report/src/index.css` ne contenait que la déclaration des layers.
- `panda codegen` générait les helpers TypeScript, mais pas `styled-system/styles.css`.
- Vite single-file inlineait donc un CSS vide : seulement `@layer reset,base,tokens,recipes,utilities;`.

Correction faite :

- `apps/report/src/index.css` importe maintenant `../styled-system/styles.css`.
- les scripts `dev`, `build` et `check` lancent `panda cssgen`.
- les scripts Panda utilisent `CI=1 ... --silent` pour éviter le warning d'update-check.
- les accents de couleur des métriques sont maintenant des classes Panda statiques, pas une classe construite dynamiquement.

## Verification deja faite

Commandes passees :

```sh
bun run check
bun run lint
bun run test
bun run build
bun apps/cli/src/main.ts --html --limit 1 > /private/tmp/ai-usage-report.html
```

Verification ciblee du HTML genere :

- payload injecte : oui
- tokens Panda presents : oui
- utilitaires Panda presents : oui
- accents de metriques presents : oui
- ancien style vide absent : oui

## Plan restant

1. Faire une verification visuelle dans un vrai navigateur.
   - L'app doit afficher un dashboard clair, pas une page HTML brute.
   - Verifier desktop et mobile.
   - Verifier que les tabs Ark UI changent bien de panel.
   - Verifier recherche et filtre par harness.

2. Stabiliser le contrat de donnees report.
   - Garder `UsageReportPayload` dans `packages/usage-core`.
   - Eviter que `apps/report` connaisse les details des collectors.
   - Garder `rows` pour analytics et `tableRows` pour la table limitee.

3. Decider la taille acceptable du HTML single-file.
   - Le fichier peut etre gros parce qu'il embarque toutes les lignes pour analytics.
   - Option possible plus tard : ajouter un mode `--html-table-only` ou compresser/filtrer le payload.

4. Ameliorer l'UX du report.
   - Ajouter tri dans les tables.
   - Ajouter vue details session.
   - Ajouter export CSV depuis l'app HTML.
   - Ajouter resume par projet.

5. Ajouter un test de non-regression pour le CSS bundle.
   - Verifier que `apps/report/dist/index.html` contient `--colors-canvas`.
   - Verifier que le HTML ne contient pas uniquement le style `@layer ...`.

## Notes

- `apps/report/dist` et `apps/report/styled-system` sont generes et ignores par git.
- La verification Browser integree n'etait pas disponible dans la session precedente, donc la QA visuelle reste a faire manuellement ou via un navigateur automatisable.
