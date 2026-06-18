# Architecture Debt Implementation Log

Journal de suivi pour l'execution de `docs/architecture-debt-implementation-plan.md`.

## Mode Operatoire

- Pick une slice ou un petit groupe de slices coherentes.
- Inspecter le code concerne avant edition.
- Implementer le plus petit changement correct.
- Tester avec les checks cibles.
- Documenter ici: travail fait, difficultes, decisions, fichiers touches.
- Committer uniquement les fichiers de la slice terminee.
- Repeter jusqu'a epuisement du plan ou blocage explicite.

## Etat Global

- Plan source: `docs/architecture-debt-implementation-plan.md`
- Statut actuel: Slice 3 implementee et verifiee
- Slice en cours: commit Slice 3
- Dernier commit de suivi: `eda1ddd chore(workspace): add package boundary guardrails`

## Decisions Transverses

- Les packages/apps doivent consommer les autres packages via package manager et exports publics.
- Les chemins relatifs inter-packages sont interdits, y compris dans les configs.
- `@ai-usage/design-system/preset` reste le contrat Panda officiel.
- `UsageReportPayload` reste conserve tant que l'export HTML statique en depend.

## Difficultes Transverses

- `bunx biome check .` complet expose des diagnostics preexistants hors scope: formatage, imports generes, a11y. Le guardrail racine utilise donc Biome cible sur `lint/style/noRestrictedImports` plus un check texte dedie, pour eviter un cleanup global dans cette slice.

## Slices

### Slice 1: Guardrails Package

Statut: implemente, verifie, en attente commit

Objectif: empecher imports et chemins relatifs inter-packages.

Travail fait:
- Journal de suivi cree avant demarrage implementation.
- Ajout de `lint/style/noRestrictedImports` en erreur pour interdire les imports relatifs vers `packages`/`apps` et les imports prives `@ai-usage/*/src/**`.
- Ajout d'un check dedie `tools/check-workspace-relative-paths.ts` pour detecter les strings de config contenant des chemins relatifs vers `apps` ou `packages`.
- Ajout du script root `lint`.
- Changement du script root `check` pour executer `lint` avant `turbo run check`.
- Exclusion Biome de `.turbo`, `.output`, `dist`, `node_modules` et `styled-system`.
- Remplacement des scripts `apps/report` qui appelaient `../../packages/design-system` par `bun --filter @ai-usage/design-system build`.

Difficultes:
- Biome scannait `.turbo/cache`; exclusion ajoutee.
- `biome check .` complet n'est pas encore un check propre du repo a cause de diagnostics preexistants non lies a cette slice.

Decisions:
- Le script root `lint` cible uniquement `lint/style/noRestrictedImports` pour le guardrail d'import, puis execute le check texte dedie.
- Le check texte ignore `biome.json`, car ce fichier contient les patterns interdits comme configuration du guardrail.

Fichiers touches:
- `docs/architecture-debt-implementation-log.md`
- `biome.json`
- `package.json`
- `tools/check-workspace-relative-paths.ts`
- `apps/report/package.json`

Checks:
- `bun run lint`: passe.
- `bun run check`: passe.

Commit:
- `eda1ddd chore(workspace): add package boundary guardrails`

### Slice 2: Panda Build Info

Statut: implemente, verifie, en attente commit

Objectif: rendre `@ai-usage/design-system` consommable par Panda sans chemin relatif vers ses sources.

Travail fait:
- Ajout du script `ship` dans `@ai-usage/design-system` pour generer `styled-system/panda.buildinfo.json` via `panda ship`.
- Ajout de l'export public `@ai-usage/design-system/panda.buildinfo.json`.
- Inclusion du `ship` dans `build` et `check` design-system.
- Remplacement du scan source relatif dans `apps/report/panda.config.ts` par un `require.resolve` de l'export build-info.
- Mise a jour du README design-system avec le nouveau contrat consommateur Panda.

Difficultes:
- `createRequire(import.meta.url)` echoue sous le bundling CJS de Panda. La config utilise donc `require.resolve` sans `import.meta`.
- `require.resolve` statique direct declenchait un warning esbuild; le specifier est passe par une constante pour eviter ce warning.

Decisions:
- Le build-info reste dans `styled-system/panda.buildinfo.json`, car `turbo.json` cache deja `styled-system/**` pour le design-system.
- `@ai-usage/design-system/preset` reste requis cote app pour partager tokens, conditions et global CSS avec le build-info.

Fichiers touches:
- `packages/design-system/package.json`
- `packages/design-system/README.md`
- `apps/report/panda.config.ts`
- `apps/report/package.json`

Checks:
- `bun run --cwd packages/design-system build`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run check`: passe.

Commit:
- `eda1ddd chore(workspace): add package boundary guardrails`

### Slice 3: Clarifier Design-System Vs Report UI

Statut: implemente, verifie, en attente commit

Objectif: separer le contrat root generique du namespace report specifique a l'app report.

Travail fait:
- Inspection des exports `@ai-usage/design-system`, `@ai-usage/design-system/report` et des imports de `apps/report`.
- Resserrement du barrel root aux primitives generiques: `HarnessBadge`, `MetricTile`, `SegmentBar`, `aiUsagePreset`, plus types de props/segments.
- Ajout d'un commentaire court dans `src/report.ts` pour marquer le namespace comme specifique report.
- Documentation README: root = primitives generiques; `./report` = API specifique report, pas le chemin par defaut des futures apps.

Difficultes:
- Aucune difficulte technique.

Decisions:
- Ne pas creer de nouveau package `report-ui` dans cette slice.
- Ne pas changer les imports de `apps/report`; ils utilisent deja le namespace `@ai-usage/design-system/report`.
- Garder les types `MetricTileProps` et `BarSegment` dans le root, car ils appartiennent aux primitives generiques exportees.

Fichiers touches:
- `packages/design-system/src/index.ts`
- `packages/design-system/src/report.ts`
- `packages/design-system/README.md`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/design-system check`: passe.
- `bun run lint`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run check`: passe.

Commit:
- Non committe.

## Journal Chronologique

### 2026-06-18

- Cree ce journal de suivi avant l'implementation.
- Pick initial: Slice 1 + Slice 2, car les guardrails doivent preceder les refactors profonds et Panda contient une violation connue de chemin relatif inter-package.
- Implemente Slice 1: guardrails Biome cibles, check texte dedie, scripts workspace sans `../../packages/design-system`.
- Implemente Slice 2: generation/export `panda.buildinfo.json`, consommation par `apps/report` via package export.
- Verifie avec `bun run lint`, `bun run --cwd packages/design-system build`, `bun run --cwd apps/report check`, `bun run check`.
- Commit Slice 1 + Slice 2: `eda1ddd chore(workspace): add package boundary guardrails`.
- Pick Slice 3: clarifier le contrat root design-system et le namespace report.
- Verifie Slice 3 avec `bun run --cwd packages/design-system check`, `bun run --cwd apps/report check`, `bun run lint`, `bun run check`.
