# Architecture Debt Implementation Plan

## Objectif

Traiter les hotspots de dette architecturale identifies dans l'audit `ai-usage`, avec des slices petites, pickables par des agents IA, et verifiables independamment.

Principes directeurs:

- Chaque package/app doit rester autonome.
- Toute dependance inter-package doit passer par le package manager et les exports publics.
- Pas de chemins relatifs inter-packages du type `../../packages/...` ou `../apps/...`.
- Local history reste le seul input des reports; aucun provider API.
- Ne pas supprimer `UsageReportPayload` tant que l'export HTML statique en depend.
- Ne pas remplacer TanStack Start, Nitro, PandaCSS ou Effect dans ce plan.
- Preserver le comportement avant de changer le modele de donnees.

## Ordre Recommande

1. Guardrails package/autonomie.
2. Panda/design-system.
3. Reporting Module.
4. Session seam.
5. Usage row provenance.
6. Local history warnings.
7. Report runtime seam.
8. Table schema.
9. Dashboard model.
10. Cleanup docs/tests.

## Regles Pour Agents

- Un agent prend une seule slice, sauf instruction explicite.
- Un agent ne melange pas refactor structurel et changement UI.
- Un agent garde les commits petits et le comportement observable stable.
- Un agent lance les checks cibles de sa slice avant de rendre la main.
- Un agent documente toute exception temporaire a la regle d'autonomie package.
- Un agent ne contourne pas `packages/reporting` depuis une app, sauf exception documentee.

## Slice 1: Guardrails Package

### But

Empecher les imports et chemins relatifs inter-packages.

### Fichiers

- `biome.json`
- `tools/biome/no-workspace-relative-paths.grit`
- `package.json`
- docs si necessaire

### Etapes

1. Activer `lint/style/noRestrictedImports` en erreur.
2. Interdire les patterns d'import suivants:
   - `../packages/**`
   - `../../packages/**`
   - `../../../packages/**`
   - `../apps/**`
   - `../../apps/**`
   - `../../../apps/**`
   - `@ai-usage/*/src/**`
3. Ajouter un plugin Biome Grit pour detecter les strings de config contenant `../packages/` ou `../apps/`.
4. Ajouter un script root `lint`: `biome check .`.
5. Corriger les violations existantes ou les documenter comme exceptions temporaires.

### Critere D'acceptation

- `bunx biome check .` echoue si un import relatif cross-package est ajoute.
- `apps/report/panda.config.ts` ne contient plus `../../packages/design-system`.
- Les exceptions restantes sont explicites et justifiees.

### Checks

```sh
bunx biome check .
bun run check
```

## Slice 2: Panda Build Info

### But

Rendre `@ai-usage/design-system` consommable par Panda sans chemin relatif vers ses sources.

### Fichiers

- `packages/design-system/package.json`
- `packages/design-system/panda.config.ts`
- `apps/report/panda.config.ts`
- `packages/design-system/README.md`

### Etapes

1. Ajouter un script `ship`: `panda ship --outfile dist/panda.buildinfo.json`.
2. Exporter `./panda.buildinfo.json` depuis `@ai-usage/design-system`.
3. Dans `apps/report/panda.config.ts`, remplacer le glob relatif par un chemin resolu via package export.
4. Garder `aiUsagePreset` comme preset officiel.
5. Clarifier le README: une app Panda consomme le preset + le build-info, pas les sources via chemin relatif.

### Critere D'acceptation

- Aucune reference `../../packages/design-system` dans `apps/report/panda.config.ts`.
- `apps/report` peut generer son CSS apres le build du design-system.
- Les composants design-system restent utilisables via package exports.

### Checks

```sh
bun run --cwd packages/design-system build
bun run --cwd apps/report check
bun run check
```

## Slice 3: Clarifier Design-System Vs Report UI

### But

Separer les primitives generiques du design-system des styles specifiques au report.

### Fichiers

- `packages/design-system/src/index.ts`
- `packages/design-system/src/report.ts`
- `packages/design-system/src/components/*`
- `packages/design-system/README.md`

### Etapes

1. Classer les exports en deux groupes: primitives generiques et UI specifique report.
2. Garder le root export minimal: `HarnessBadge`, `MetricTile`, `SegmentBar`, `aiUsagePreset`.
3. Documenter le statut de `./report`: temporaire ou assumé.
4. Ne pas creer `packages/report-ui` dans cette slice sauf besoin concret.
5. Eviter les renommages massifs.

### Critere D'acceptation

- Le contrat public est documente.
- Les apps futures ne sont pas encouragees a importer `@ai-usage/design-system/report`.
- Aucun changement visuel.

### Checks

```sh
bun run --cwd packages/design-system check
bun run --cwd apps/report check
```

## Slice 4: Reporting Module Canonique

### But

Faire de `packages/reporting` le Module profond pour rows, payload, snapshots et project sources.

### Fichiers

- `packages/reporting/src/index.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/serve.ts`
- `apps/cli/src/setup.ts`

### Etapes

1. Ajouter `createLocalUsageSnapshot(request)`.
2. Ajouter `createMergedUsageReport(request)`.
3. Ajouter `listProjectSources(request)`.
4. Deplacer config, Cursor CSV, aliases et facets dans reporting.
5. Remplacer les imports directs de `collectSelectedHarnessRows` dans CLI hors quota.
6. Garder CLI comme adapter argv/render/file/http.

### Critere D'acceptation

- `apps/cli/src/main.ts` n'importe plus `collectSelectedHarnessRows`.
- `serve` n'assemble plus manuellement Local history.
- `setup` ne collecte plus directement les rows locales.
- Snapshot/merge gardent le meme format.

### Checks

```sh
bun run --cwd packages/reporting test
bun run --cwd apps/cli test
bun run check
```

## Slice 5: Contract Tests Reporting

### But

Securiser le seam reporting avant les refactors plus profonds.

### Fichiers

- `packages/reporting/src/reporting.test.ts`
- fixtures de test si necessaire

### Etapes

1. Ajouter une fixture Local history vide.
2. Ajouter des fixture rows avec provenance, aliases et Cursor config.
3. Tester la compatibilite du payload.
4. Tester la creation snapshot avec facets.
5. Tester merge local + snapshot files sans lire la vraie home machine.

### Critere D'acceptation

- Les tests prouvent la parite des chemins CLI/reporting.
- Aucun test ne lit la vraie home machine.

### Checks

```sh
bun run --cwd packages/reporting test
bun run test
```

## Slice 6: Introduire CollectedSession

### But

Creer un seam explicite `Local history -> Session -> Usage row`.

### Fichiers

- `packages/local-collectors/src/session.ts`
- `packages/local-collectors/src/collectors/codex.ts`
- `packages/local-collectors/src/codex-history.ts`
- `packages/usage-core/src/usage-row.ts`

### Etapes

1. Definir `CollectedSession` avec dates, harness key, provider route, title, project path, tokens, markers et source id.
2. Ajouter `sessionToUsageRow(session)`.
3. Migrer Codex en premier, car il expose deja `CodexUsageSession`.
4. Garder `collectCodex` avec un output identique.
5. Ajouter tests de mapping `Session -> Usage row`.

### Critere D'acceptation

- Codex passe par `CollectedSession`.
- Les rows produites restent identiques.
- Provider, Cost approximation et markers sont testes au seam.

### Checks

```sh
bun test packages/local-collectors/src/codex-history.test.ts
bun run --cwd packages/local-collectors check
```

## Slice 7: Migrer Collectors Vers Session Seam

### But

Supprimer la duplication de `normalizeUsageRow` par harness.

### Fichiers

- `packages/local-collectors/src/collectors/claude.ts`
- `packages/local-collectors/src/collectors/opencode.ts`
- `packages/local-collectors/src/collectors/cursor.ts`
- `packages/local-collectors/src/collectors/cursor-csv.ts`
- `packages/local-collectors/src/collectors/cursor-reconcile.ts`

### Etapes

1. Migrer Claude.
2. Migrer OpenCode.
3. Migrer Cursor DB.
4. Migrer Cursor CSV reconciliation.
5. Garder RTK enrichment apres Usage row tant que necessaire.

### Critere D'acceptation

- Chaque collector expose des Sessions internes ou passe par le mapper commun.
- Les champs Provider, Cost approximation, partial et usageUnavailable restent identiques.
- Le nombre d'appels directs a `normalizeUsageRow` baisse fortement.

### Checks

```sh
bun test packages/local-collectors/src/*.test.ts
bun run test
```

## Slice 8: Provenance First-Class

### But

Supprimer les casts `Partial<SourcedRow>`.

### Fichiers

- `packages/usage-core/src/types.ts`
- `packages/usage-core/src/report-data.ts`
- `packages/usage-core/src/snapshot.ts`
- `packages/usage-core/src/project-alias.ts`
- CLI renderers

### Etapes

1. Creer des types explicites: `CollectedUsageRow`, `UsageRow`, `SerializedUsageRow`, `SnapshotUsageRow`.
2. Mettre `source` sur le type qui en a reellement besoin.
3. Faire `applyProjectAliases` accepter des rows avec provenance explicite.
4. Faire `serializeUsageRow` preserver provenance sans cast.
5. Adapter CSV, table et snapshot.

### Critere D'acceptation

- Aucun cast `(row as Partial<SourcedRow>)` dans core/CLI/report.
- Snapshot merge garde le meme JSON.
- TypeScript encode ou la provenance existe.

### Checks

```sh
bun run --cwd packages/usage-core test
bun run --cwd apps/cli test
bun run check
```

## Slice 9: Local History Warnings

### But

Ne plus confondre absence de data et echec silencieux.

### Fichiers

- `packages/local-collectors/src/local-history.ts`
- collectors
- `packages/reporting/src/index.ts`

### Etapes

1. Ajouter type `LocalHistoryWarning`.
2. Ajouter helpers `optionalText`, `optionalDb`, `readJsonlLines`, `querySqlite`.
3. Remplacer les `catchAll(() => [])` par des warnings structures.
4. Ajouter result envelope par harness: `{ harness, rows, warnings, durationMs, status }`.
5. Garder la flat rows API comme compatibility wrapper.

### Critere D'acceptation

- Un harness peut echouer sans bloquer les autres.
- Le payload peut porter warnings sans casser UI.
- Les tests couvrent un harness failing + un harness successful.

### Checks

```sh
bun run --cwd packages/local-collectors test
bun run --cwd packages/reporting test
```

## Slice 10: Payload Warnings UI

### But

Rendre les partial failures visibles.

### Fichiers

- `packages/usage-core/src/report-data.ts`
- `apps/report/src/Dashboard.tsx`
- nouveau petit module UI si utile

### Etapes

1. Ajouter champ optionnel `warnings` au payload.
2. Rendre un panneau discret dans le dashboard.
3. Ajouter notes CLI pour warnings.
4. Ne pas bloquer export HTML.

### Critere D'acceptation

- Warning visible dans app et CLI.
- Payload sans warning reste compatible.
- Demo payload inchange ou warning vide.

### Checks

```sh
bun run --cwd apps/report test
bun run --cwd apps/cli test
```

## Slice 11: Report Runtime Module

### But

Centraliser SSR, injected payload, refresh, demo fallback et export.

### Fichiers

- `apps/report/src/report-data.ts`
- `apps/report/src/routes/index.tsx`
- `apps/report/src/server/report-payload.ts`
- `apps/report/src/server/report-payload.server.ts`
- nouveau `apps/report/src/report-runtime.ts`

### Etapes

1. Creer `report-runtime.ts`.
2. Deplacer `exportPayload`, `loadReportPayload`, `readReportPayload`, `fetchReportPayload`.
3. Encapsuler le Bun subprocess dans un adapter nomme.
4. Faire la route appeler uniquement runtime.
5. Ajouter tests importables cote server sans charger de code client TanStack par accident.

### Critere D'acceptation

- `routes/index.tsx` ne connait plus `globalThis`, `window.__AI_USAGE_REPORT__`, `import.meta.env.SSR`.
- Le subprocess reste mais il est isole.
- Le mode static HTML continue.

### Checks

```sh
bun run --cwd apps/report test
bun run --cwd apps/report check
```

## Slice 12: HTML Export Adapter Unique

### But

Reduire la duplication asset inlining/payload injection.

### Fichiers

- `apps/cli/src/render/html.ts`
- `apps/report/src/dashboard-export.ts`
- `packages/usage-core/src/html-export.ts`

### Etapes

1. Creer une Interface commune `InlineReportHtmlInput`.
2. Garder deux adapters asset reader: filesystem et browser fetch.
3. Centraliser la generation du payload script.
4. Centraliser la discovery regex des assets si possible.
5. Conserver le comportement single-file.

### Critere D'acceptation

- CLI export et browser export partagent le meme Module d'inlining.
- Pas de changement de payload.
- Export HTML s'ouvre offline.

### Checks

```sh
bun run --cwd apps/report test
bun run html export --since 1d
```

## Slice 13: Table Schema Module

### But

Avoir une source de verite pour colonnes, sort, URL et CSV.

### Fichiers

- `apps/report/src/dashboard-search.ts`
- `apps/report/src/session-columns.tsx`
- `apps/report/src/dashboard-sort.ts`
- `apps/report/src/dashboard-export.ts`
- nouveau `apps/report/src/session-table-schema.ts`

### Etapes

1. Creer `session-table-schema.ts`.
2. Deplacer ids, labels, default visibility et sort accessors.
3. Faire `dashboard-search` utiliser le schema.
4. Faire `session-columns` generer depuis le schema ou referencer le schema strictement.
5. Faire CSV exporter depuis le schema ou un schema export dedie.
6. Supprimer le fallback silencieux de sort inconnu.

### Critere D'acceptation

- Ajouter une colonne demande une modification principale dans le schema.
- URL validation, table sort et CSV utilisent les memes ids.
- Tests couvrent sort et column visibility.

### Checks

```sh
bun run --cwd apps/report test
bun run --cwd apps/report check
```

## Slice 14: Dashboard Model

### But

Sortir la logique de `Dashboard.tsx`.

### Fichiers

- `apps/report/src/Dashboard.tsx`
- nouveau `apps/report/src/dashboard-model.ts`
- tests associes

### Etapes

1. Extraire les fonctions pures pour filter snapshot -> timeline rows.
2. Extraire date bounds -> visible summary.
3. Extraire sorting/export rows.
4. Extraire metrics + previous period.
5. Garder les Solid signals dans le composant au debut.
6. Ajouter tests purs avant de reduire JSX.

### Critere D'acceptation

- `Dashboard.tsx` perd la logique calculatoire principale.
- Tests couvrent filtres, date range, metrics et export order.
- Aucun changement visuel.

### Checks

```sh
bun run --cwd apps/report test
bun run --cwd apps/report check
```

## Slice 15: Overview Analytics Model

### But

Sortir les calculs de `Overview.tsx`.

### Fichiers

- `apps/report/src/Overview.tsx`
- nouveau `apps/report/src/overview-model.ts`

### Etapes

1. Extraire heatmap data.
2. Extraire punchcard data.
3. Extraire top sessions/projects/model migration.
4. Garder seulement le rendu SVG/JSX dans `Overview`.
5. Ajouter tests sur les modeles.

### Critere D'acceptation

- `Overview.tsx` devient majoritairement rendu.
- Les calculs ont tests sans DOM.
- Aucun changement visuel.

### Checks

```sh
bun run --cwd apps/report test
bun run --cwd apps/report check
```

## Slice 16: Package Export Audit

### But

Empecher les bypass des seams publics.

### Fichiers

- `package.json` de chaque package
- imports apps/packages
- `biome.json`

### Etapes

1. Lister les exports reellement utilises.
2. Reduire les barrels trop larges si possible.
3. Garder les subpaths publics necessaires.
4. Ajouter `noRestrictedImports` pour `@ai-usage/core/src/**`, `@ai-usage/local-collectors/src/**`, et equivalents.
5. Documenter les Interfaces publiques.

### Critere D'acceptation

- Apps/packages importent les packages via exports publics.
- Aucun import direct vers `src` d'un autre package.
- Les adapters ne contournent plus reporting sauf exception quota.

### Checks

```sh
bunx biome check .
bun run check
```

## Slice 17: Tooling Generated Ownership

### But

Rendre Panda/TanStack generation explicite et moins stateful.

### Fichiers

- `turbo.json`
- `apps/report/package.json`
- `packages/design-system/package.json`
- `biome.json`

### Etapes

1. Ajouter outputs Turbo pour report si utile: `dist/**`, `.output/**`, `styled-system/**`.
2. Decider si `routeTree.gen.ts` est tracked ou generated ignored.
3. Si tracked, configurer Biome pour ne pas le formater/linter.
4. Si ignored, ajouter generation explicite dans scripts.
5. Supprimer les builds manuels redondants si Turbo les garantit.

### Critere D'acceptation

- `bun run check` fonctionne depuis clean checkout apres install.
- Pas de generation implicite non documentee.
- Biome ne lint pas les artifacts generes.

### Checks

```sh
bun run check
bun run build
bun run test
```

## Slice 18: Documentation Architecture

### But

Rendre la nouvelle architecture navigable par humains et agents IA.

### Fichiers

- `CONTEXT.md`
- `README.md`
- nouveau `docs/architecture.md` si utile
- `docs/report-data-architecture-refactor-log.md`

### Etapes

1. Ajouter termes si necessaires: `Collected session`, `Report payload`, `Snapshot`.
2. Documenter package ownership.
3. Documenter les adapters autorises.
4. Documenter la regle “no relative cross-package paths”.
5. Mettre a jour le plan/refactor log existant avec completed/follow-up.

### Critere D'acceptation

- Un agent peut savoir ou changer reporting, collection, UI et Panda.
- Les decisions Panda/design-system sont explicites.
- La doc respecte le vocabulaire de `CONTEXT.md`.

### Checks

Docs only. Pas de test requis sauf modification de code adjacente.

## Premier Ticket Recommande

### Titre

Interdire les chemins relatifs inter-packages et migrer Panda vers build-info design-system.

### Scope

Implementer uniquement Slice 1 et Slice 2.

### Instructions

- Ne pas toucher au rendu UI.
- Ne pas toucher au reporting runtime.
- Remplacer le `include` Panda relatif par un artefact package-manager-resolved.
- Ajouter les guardrails Biome/Grit pour empecher la regression.

### Checks

```sh
bunx biome check .
bun run --cwd packages/design-system build
bun run --cwd apps/report check
bun run check
```

## Risques Connus

- Panda build-info peut demander un ajustement fin des exports Bun/workspaces.
- `Usage row` provenance est la slice la plus risquee pour snapshot/merge.
- Session seam peut changer les Cost approximations si les fixtures sont insuffisantes.
- Runtime report est sensible aux contraintes TanStack Start/Nitro et `bun:sqlite`.
