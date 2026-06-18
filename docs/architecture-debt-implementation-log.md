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
- Statut actuel: Slice 9 implementee et verifiee
- Slice en cours: commit Slice 9
- Dernier commit de suivi: `cbab52b refactor(core): make row provenance explicit`

## Decisions Transverses

- Les packages/apps doivent consommer les autres packages via package manager et exports publics.
- Les chemins relatifs inter-packages sont interdits, y compris dans les configs.
- `@ai-usage/design-system/preset` reste le contrat Panda officiel.
- `UsageReportPayload` reste conserve tant que l'export HTML statique en depend.

## Difficultes Transverses

- `bunx biome check .` complet expose des diagnostics preexistants hors scope: formatage, imports generes, a11y. Le guardrail racine utilise donc Biome cible sur `lint/style/noRestrictedImports` plus un check texte dedie, pour eviter un cleanup global dans cette slice.

## Slices

### Slice 1: Guardrails Package

Statut: implemente, verifie, committe

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

Statut: implemente, verifie, committe

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

Statut: implemente, verifie, committe

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
- `c062524 chore(design-system): clarify public exports`

### Slice 4: Reporting Module Canonique

Statut: implemente, verifie, committe

Objectif: faire de `packages/reporting` le Module profond pour snapshots, merge et project sources.

Travail fait:
- Ajout de `createLocalUsageSnapshot` dans `packages/reporting`.
- Ajout de `createMergedUsageReport` dans `packages/reporting`.
- Ajout de `listProjectSources` et du type `ProjectSource` dans `packages/reporting`.
- Factorisation interne `collectConfiguredLocalRows` pour lire config, Cursor CSV et rows locales au meme endroit.
- Migration `apps/cli/src/main.ts`: `snapshot`, `merge`, `projects list` passent par `@ai-usage/reporting`.
- Migration `apps/cli/src/serve.ts`: `/snapshot` passe par `createLocalUsageSnapshot`.
- Migration `apps/cli/src/setup.ts`: source discovery passe par `listProjectSources`; setup garde HTML, serveur et ecriture config.
- Verification grep: plus de `collectSelectedHarnessRows`, `collectHarnessFacets`, `createUsageSnapshot`, `mergeUsageSnapshots`, `applyProjectAliases`, `usageRowTokenTotal` dans `apps/cli/src`.

Difficultes:
- `exactOptionalPropertyTypes` impose d'omettre les proprietes optionnelles `undefined`; ajout d'un helper `toLocalUsageSnapshotRequest`.
- `setup --local` profite maintenant du chemin reporting, donc de la config Cursor mergee, alors que l'ancien setup collectait local sans config Cursor explicite.

Decisions:
- Le CLI reste adapter fichiers/HTTP/stdout; `parseUsageSnapshot` reste cote CLI pour lire fichiers/remotes.
- `createMergedUsageReport` applique les aliases apres merge pour conserver le comportement CLI existant.
- `listProjectSources` ne fait pas d'aliasing, car setup a besoin des sources brutes pour creer des aliases.
- L'enrichissement git remote local vit dans reporting avec les project sources.

Fichiers touches:
- `packages/reporting/src/index.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/serve.ts`
- `apps/cli/src/setup.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/reporting check`: passe.
- `bun run --cwd apps/cli check`: passe.
- `bun run --cwd apps/cli test`: passe.
- `bun run check`: passe.

Commit:
- `398dd7e refactor(reporting): own snapshots and project sources`

### Slice 5: Contract Tests Reporting

Statut: implemente, verifie, committe

Objectif: securiser le seam reporting avant les refactors plus profonds.

Travail fait:
- Ajout d'un test `createLocalUsageSnapshot` avec provenance machine sans lire la vraie home.
- Ajout d'un test `createMergedUsageReport` avec snapshots, dedupe, warning et alias post-merge.
- Ajout d'un test `listProjectSources` avec grouping source et remote git local.
- Conservation des tests existants payload/config cwd.

Difficultes:
- Aucune difficulte technique apres correction des optionnels TypeScript.

Decisions:
- Les fixtures utilisent `mkdtempSync` + `createLocalHistoryStorage(home)`.
- Les tests ne fournissent jamais `LocalHistoryStorageLive`.

Fichiers touches:
- `packages/reporting/src/reporting.test.ts`

Checks:
- `bun run --cwd packages/reporting test`: passe.
- `bun run --cwd packages/reporting check`: passe.

Commit:
- `398dd7e refactor(reporting): own snapshots and project sources`

### Slice 6: Introduire CollectedSession

Statut: implemente, verifie, committe

Objectif: creer un seam explicite `Local history -> Session -> Usage row` et migrer Codex en premier.

Travail fait:
- Ajout de `CollectedSession`, `CollectedSessionSource` et `sessionToUsageRow` dans `packages/local-collectors/src/collected-session.ts`.
- Export du nouveau seam depuis `packages/local-collectors/src/index.ts`.
- Migration de `readCodexUsageSessions` pour retourner des `CollectedSession` au lieu de `CodexUsageSession` specifique Codex.
- Migration de `collectCodex` vers `readCodexUsageSessions.map(sessionToUsageRow)`.
- Mise a jour du test Codex pour verifier provider, project, projectPath, source et markers au niveau session et row.

Difficultes:
- Les markers explicites `false` doivent rester portes par le seam; le mapper conserve les champs optionnels definis, y compris `false`.
- Le parent Codex avec child sessions devient `subagent: true` des le niveau `CollectedSession`, comme le row final le faisait deja.

Decisions:
- Le seam vit dans `packages/local-collectors`, pas dans `usage-core`, car il represente la sortie normalisee des collecteurs locaux avant Usage row.
- `sessionToUsageRow` reste le seul endroit Codex-independant qui appelle `normalizeUsageRow` pour ce seam.
- Codex conserve `project: base(cwd)` et `projectPath: cwd` separement.

Fichiers touches:
- `packages/local-collectors/src/collected-session.ts`
- `packages/local-collectors/src/index.ts`
- `packages/local-collectors/src/codex-history.ts`
- `packages/local-collectors/src/collectors/codex.ts`
- `packages/local-collectors/src/codex-history.test.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun test packages/local-collectors/src/codex-history.test.ts`: passe.
- `bun run --cwd packages/local-collectors check`: passe.
- `bun run --cwd packages/local-collectors test`: passe.
- `bun run check`: passe.

Commit:
- `0304bb9 refactor(collectors): add collected session seam`

### Slice 7: Migrer Collectors Vers Session Seam

Statut: implemente, verifie, committe

Objectif: faire passer Claude, OpenCode, Cursor DB et Cursor CSV reconciliation par `CollectedSession -> sessionToUsageRow`.

Travail fait:
- Migration `collectors/claude.ts`: sessions detaillees et fallbacks prompt-history produisent des `CollectedSession`.
- Migration `collectors/opencode.ts`: aggregation SQLite conserve `seen`, `pricingModel`, lignes et provenance, puis mappe via `sessionToUsageRow`.
- Migration `collectors/cursor.ts`: rows Cursor DB token-backed et usage-unavailable passent par `CollectedSession`.
- Migration `collectors/cursor-reconcile.ts`: clusters CSV reconciles et orphan clusters construisent des `CollectedSession` au point ou une session existe.
- `collectors/cursor-csv.ts` reste inchange, car il parse des turns/clusters, pas des sessions.
- Verification grep: plus d'appel direct a `normalizeUsageRow`, `withSource`, `withProjectPath` dans les collecteurs, hors `cursor-reconcile` qui garde seulement `harnessLabel` pour filtrer les rows Cursor.

Difficultes:
- Cursor CSV devait rester en deux phases: parsing de turns inchangé, conversion en session seulement apres reconciliation.
- Pour les rows Cursor source-less potentielles dans `reconcileCursorRows`, le mapper ajoute une source temporaire puis elle est retiree si la row d'origine n'avait pas de source.

Decisions:
- Ne pas forcer `cursor-csv.ts` dans le seam car il ne connait pas encore les sessions.
- Garder `partial`/`usageUnavailable` absents sur les rows Cursor reconciliees, comme avant.
- Garder `subagent: false` explicite pour les sessions Claude detaillees quand `sidechain` est faux.

Fichiers touches:
- `packages/local-collectors/src/collectors/claude.ts`
- `packages/local-collectors/src/collectors/opencode.ts`
- `packages/local-collectors/src/collectors/cursor.ts`
- `packages/local-collectors/src/collectors/cursor-reconcile.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun test packages/local-collectors/src/db-collectors.test.ts packages/local-collectors/src/cursor-csv-reconcile.test.ts packages/local-collectors/src/codex-history.test.ts`: passe.
- `bun run --cwd packages/local-collectors check`: passe.
- `bun run --cwd packages/local-collectors test`: passe.
- `bun run check`: passe.

Commit:
- `dc0a764 refactor(collectors): finish session seam migration`

### Slice 8: Provenance First-Class

Statut: implemente, verifie, en attente commit

Objectif: supprimer les casts `Partial<SourcedRow>` et rendre la provenance explicite dans les types.

Travail fait:
- Ajout de types explicites dans `usage-core`: `UsageRow`, alias compat `Row`, `UsageRowWithOptionalSource`, `CollectedUsageRow`, alias compat `SourcedRow`.
- Renommage du type de serialization en `SerializedUsageRow`, avec alias compat `SerializedRow` pour l'app report.
- `serializeUsageRow`, snapshot, CSV, project aliases, reporting project sources et Cursor reconciliation lisent maintenant `row.source` via des types explicites.
- `SnapshotMergeResult` et `deserializeSnapshotRow` retournent des rows avec provenance requise via `CollectedUsageRow`.
- `CollectorRow` encode la provenance optionnelle et `stripProjectPath` conserve ce type au lieu de cacher `source` derriere `Row`.
- Nettoyage des tests `project-alias` et `snapshot` pour ne plus masquer la provenance via casts.
- Verification grep: plus de cast `(row as Partial<SourcedRow>)` dans le repo.

Difficultes:
- `UsageReportPayload` et les consumers report utilisent encore le nom public `SerializedRow`; un alias compat est conserve pour eviter un rename large hors slice.
- Les rows locales peuvent etre avec ou sans provenance selon `keepSource`; le type intermediaire `UsageRowWithOptionalSource` encode ce seam sans forcer tous les call sites a porter une source.

Decisions:
- Garder `Row` et `SourcedRow` comme alias publics temporaires pour limiter le churn.
- Ne pas changer la forme JSON snapshot/payload; seules les annotations TypeScript changent.
- Garder `CollectedUsageRow` cote core pour les rows deserializees depuis snapshot, distinct de `CollectedSession` cote collectors.

Fichiers touches:
- `packages/usage-core/src/types.ts`
- `packages/usage-core/src/report-data.ts`
- `packages/usage-core/src/snapshot.ts`
- `packages/usage-core/src/project-alias.ts`
- `packages/usage-core/src/project-alias.test.ts`
- `packages/usage-core/src/snapshot.test.ts`
- `packages/local-collectors/src/rtk-enrichment.ts`
- `packages/local-collectors/src/collectors/cursor-reconcile.ts`
- `packages/reporting/src/index.ts`
- `apps/cli/src/render/csv.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/usage-core check`: passe.
- `bun run --cwd packages/usage-core test`: passe.
- `bun run --cwd apps/cli test`: passe.
- `bun run check`: passe.

Commit:
- `cbab52b refactor(core): make row provenance explicit`

### Slice 9: Local History Warnings

Statut: implemente, verifie, en attente commit

Objectif: distinguer absence normale de local history et echecs partiels silencieux.

Travail fait:
- Ajout de `LocalHistoryWarning` et `localHistoryWarningFromError` dans `packages/local-collectors/src/errors.ts`.
- Ajout de `collectSelectedHarnessResults(selection)` avec enveloppe par harness: rows, warnings, duration, status `ok | warning | failed`.
- Conservation de `collectSelectedHarnessRows(selection)` comme wrapper compatibilite qui retourne uniquement les rows finales.
- Capture des erreurs de collector au niveau harness sans bloquer les autres harnesses.
- Refactor OpenCode: `collectOpenCodeResult` capture les echecs par base live/stable et conserve les rows de l'autre base si possible.
- Refactor RTK: `enrichCollectorRowsWithRtkSavingsResult` conserve les rows d'entree et retourne un warning structure si l'enrichissement echoue.
- Cursor CSV import dans l'orchestrateur devient best-effort: un CSV illisible ajoute un warning Cursor et conserve les rows locales.
- Reporting expose `collectLocalReportRowsWithWarnings(request)` sans changer la forme actuelle du payload JSON.
- Ajout d'un test local-collectors: OpenCode DB partiellement cassée produit un warning tandis que Codex fournit toujours une row; l'API flat reste compatible.

Difficultes:
- Certaines `catchAll` restantes representent des probes d'existence/config ou des chemins hors payload principal; elles sont laissees hors scope pour eviter un refactor trop large.
- Le payload n'expose pas encore les warnings; Slice 10 portera la visibilite UI/CLI.
- `readMergedAiUsageConfigFrom` peut encore echouer; l'API reporting avec warnings garde donc `LocalHistoryError` comme erreur possible pour la config.

Decisions:
- Les warnings RTK sont globaux avec `harness: 'rtk'`, pas rattaches a un harness de session.
- Les rows finales de l'enveloppe sont les rows apres Cursor CSV reconciliation, RTK enrichment et strip `keepSource`, pour rester alignees avec l'API flat.
- Les warnings OpenCode live/stable sont captures au niveau DB pour eviter de jeter les rows d'une base saine.
- Ne pas ajouter `warnings` a `UsageReportPayload` dans cette slice.

Fichiers touches:
- `packages/local-collectors/src/errors.ts`
- `packages/local-collectors/src/collectors/index.ts`
- `packages/local-collectors/src/collectors/opencode.ts`
- `packages/local-collectors/src/rtk-enrichment.ts`
- `packages/local-collectors/src/db-collectors.test.ts`
- `packages/reporting/src/index.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/local-collectors check`: passe.
- `bun run --cwd packages/reporting check`: passe.
- `bun run --cwd packages/local-collectors test`: passe.
- `bun run --cwd packages/reporting test`: passe.
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
- Commit Slice 3: `c062524 chore(design-system): clarify public exports`.
- Pick Slice 4 + Slice 5: rendre `packages/reporting` canonique pour snapshot/merge/project sources avec contract tests.
- Implemente APIs reporting: `createLocalUsageSnapshot`, `createMergedUsageReport`, `listProjectSources`.
- Migre CLI `main`, `serve`, `setup` vers reporting pour les chemins local history concernes.
- Verifie Slice 4 + Slice 5 avec `bun run --cwd packages/reporting test`, `bun run --cwd packages/reporting check`, `bun run --cwd apps/cli test`, `bun run --cwd apps/cli check`, `bun run check`.
- Commit Slice 4 + Slice 5: `398dd7e refactor(reporting): own snapshots and project sources`.
- Pick Slice 6: introduire `CollectedSession` et migrer Codex en premier.
- Implemente `CollectedSession` + `sessionToUsageRow`, puis migre Codex vers ce mapper.
- Verifie Slice 6 avec `bun test packages/local-collectors/src/codex-history.test.ts`, `bun run --cwd packages/local-collectors test`, `bun run --cwd packages/local-collectors check`, `bun run check`.
- Commit Slice 6: `0304bb9 refactor(collectors): add collected session seam`.
- Pick Slice 7: migrer Claude, OpenCode, Cursor DB et Cursor CSV reconciliation vers `CollectedSession`.
- Verifie Slice 7 avec tests local-collectors cibles, `bun run --cwd packages/local-collectors test`, `bun run --cwd packages/local-collectors check`, `bun run check`.
- Commit Slice 7: `dc0a764 refactor(collectors): finish session seam migration`.
- Pick Slice 8: rendre la provenance first-class et supprimer les casts `Partial<SourcedRow>`.
- Verifie Slice 8 avec `bun run --cwd packages/usage-core check`, `bun run --cwd packages/usage-core test`, `bun run --cwd apps/cli test`, `bun run check`.
- Commit Slice 8: `cbab52b refactor(core): make row provenance explicit`.
- Pick Slice 9: ajouter warnings structures pour local history et garder l'API flat compatible.
- Verifie Slice 9 avec `bun run --cwd packages/local-collectors check`, `bun run --cwd packages/reporting check`, `bun run --cwd packages/local-collectors test`, `bun run --cwd packages/reporting test`, `bun run check`.
