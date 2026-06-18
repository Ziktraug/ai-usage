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
- Statut actuel: Slice 17 implementee et verifiee
- Slice en cours: commit Slice 17
- Dernier commit de suivi: `a1a3151 docs: record slice 16 commit`

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

Statut: implemente, verifie, committe

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

Statut: implemente, verifie, committe

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
- `70915cd refactor(collectors): report local history warnings`

### Slice 10: Payload Warnings UI

Statut: implemente, verifie, committe

Objectif: rendre les echecs partiels visibles dans le payload, le CLI et le dashboard.

Travail fait:
- Ajout de `UsageReportWarning` et du champ optionnel `warnings` dans `UsageReportPayload`.
- `createUsageReportPayload` accepte des warnings optionnels sans changer la forme des payloads sans warning.
- `createLocalReportPayload` passe par `collectLocalReportRowsWithWarnings` et injecte les warnings dans le payload.
- `createMergedUsageReport` convertit les warnings de merge snapshot en warnings de payload pour export HTML/payload.
- CLI: les rapports terminal affichent un bloc `Warnings:`; payload/html transportent les warnings.
- CLI merge: les sorties `--html` et `--payload-json` utilisent maintenant `merged.payload`, pour conserver les warnings du merge dans l'export.
- Report UI: ajout de `ReportWarnings`, un panneau discret avec liste semantique, rendu au-dessus des metrics quand `payload.warnings` est non vide.
- Ajout de tests CLI pour payload warnings et affichage terminal.

Difficultes:
- `exactOptionalPropertyTypes` impose de typer explicitement les props UI qui peuvent recevoir `undefined`.
- Le panneau UI utilise une section avec titre et liste, sans live region assertive, car ces warnings ne sont pas des interruptions critiques.

Decisions:
- Ne pas afficher les warnings dans CSV ou rows JSON; le format payload est le format structurel complet.
- Les payloads sans warning restent inchanges: le champ `warnings` est omis s'il est vide.
- Le panneau UI reste dans `apps/report`, pas dans le design-system, car il est specifique au domaine local history.

Fichiers touches:
- `packages/usage-core/src/report-data.ts`
- `packages/reporting/src/index.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/report.ts`
- `apps/cli/src/report.test.ts`
- `apps/report/src/Dashboard.tsx`
- `apps/report/src/report-warnings.tsx`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/usage-core check`: passe.
- `bun run --cwd packages/reporting check`: passe.
- `bun run --cwd apps/cli check`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run --cwd apps/cli test`: passe.
- `bun run --cwd apps/report test`: passe.
- `bun run --cwd packages/reporting test`: passe.
- `bun run check`: passe.

Commit:
- `4a6da64 feat(report): surface local history warnings`

### Slice 11: Report Runtime Module

Statut: implemente, verifie, committe

Objectif: centraliser SSR, payload injecte, refresh, demo fallback et export runtime.

Travail fait:
- Ajout de `apps/report/src/report-runtime.ts` pour porter `readReportPayload`, `isDemoReportPayload`, `fetchReportPayload`, `loadReportPayload`, `resolveInitialReportPayload` et `reportRefreshPayload`.
- `report-data.ts` redevient un module de donnees demo/facets; il exporte `demoReportPayload` et ne connait plus `window` ni server functions.
- `routes/index.tsx` ne connait plus `globalThis`, `window.__AI_USAGE_REPORT__`, `import.meta.env.SSR`, ni les imports server payload.
- `Dashboard.tsx` consomme les helpers runtime au lieu de `report-data`.
- `report-payload.server.ts` expose `runReportPayloadRunner` pour nommer explicitement l'adapter subprocess Bun, puis parse dans `runReportPayloadCollection`.
- Le runtime utilise le bridge `createServerFn` via `server/report-payload.ts`; aucun import `.server` ne fuit dans le module client-visible.
- Mise a jour du test payload bootstrap pour importer `readReportPayload` depuis le runtime.

Difficultes:
- Le build TanStack Start bloque les imports `.server` dans un module visible client, meme sous branche runtime. Le runtime passe donc uniquement par `getReportPayload` (`createServerFn`) et laisse l'import `.server` dans `server/report-payload.ts`.

Decisions:
- Garder `server/report-payload.ts` comme frontiere RPC Start officielle.
- Ne pas supprimer le runner subprocess dans cette slice; il est seulement nomme et isole.
- Ne pas deplacer `cursorCommitAttributionFacet`, car c'est un helper de lecture de payload/facets, pas du runtime.

Fichiers touches:
- `apps/report/src/report-runtime.ts`
- `apps/report/src/report-data.ts`
- `apps/report/src/report-data.test.ts`
- `apps/report/src/routes/index.tsx`
- `apps/report/src/Dashboard.tsx`
- `apps/report/src/server/report-payload.server.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd apps/report check`: passe.
- `bun run --cwd apps/report test`: passe.
- `bun run check`: passe.

Commit:
- `1721d1b refactor(report): centralize payload runtime`

### Slice 12: HTML Export Adapter Unique

Statut: implemente, verifie, committe

Objectif: reduire la duplication asset inlining et payload injection entre export CLI et export browser.

Travail fait:
- Ajout de `InlineReportHtmlInput` dans `packages/usage-core/src/html-export.ts`.
- Ajout de `createReportPayloadScript(payload)` pour centraliser l'injection `window.__AI_USAGE_REPORT__`.
- Ajout de `discoverHtmlAssetUrls(html)` pour partager la discovery regex scripts/stylesheets.
- Ajout de `inlineReportHTML(input)` qui precharge les assets, injecte le payload et appelle l'inliner existant.
- Migration `apps/cli/src/render/html.ts` vers `inlineReportHTML` avec adapter filesystem.
- Migration `apps/report/src/dashboard-export.ts` vers `inlineReportHTML` avec adapter browser `fetch`.
- Conservation du comportement single-file et du fallback asset manquant.

Difficultes:
- Le check `bun run html export --since 1d` ecrit un HTML dans `ai-usage-reports`; le fichier est ignore par git et n'apparait pas dans le status.

Decisions:
- Garder `inlineAssetsIntoHTML` comme primitive sync bas niveau; `inlineReportHTML` est l'Interface report-level async partagee.
- Ne pas changer les regex d'inlining existantes au-dela de leur centralisation.
- Ne pas ajouter de dependance pour parser HTML; les regex existantes suffisent pour les assets Start generes.

Fichiers touches:
- `packages/usage-core/src/html-export.ts`
- `apps/cli/src/render/html.ts`
- `apps/report/src/dashboard-export.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd packages/usage-core check`: passe.
- `bun run --cwd apps/cli check`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run --cwd apps/report test`: passe.
- `bun run html export --since 1d`: passe.
- `bun run check`: passe.

Commit:
- `d3e60df refactor(report): share html export inliner`

### Slice 13: Table Schema Module

Statut: implemente, verifie, committe

Objectif: creer une source de verite pour les colonnes de session, le tri, la visibilite URL et le CSV report.

Travail fait:
- Ajout de `apps/report/src/session-table-schema.ts`.
- Deplacement des ids de colonnes, types `SessionColumnId` / `SearchableColumnDiffId`, guards et diff visibility URL dans le schema.
- Deplacement des accessors de tri dans le schema via `sortValueForSessionColumn`.
- `dashboard-search.ts` valide les colonnes et tris via le schema.
- `Dashboard.tsx` consomme `columnVisibilityFromDiff`, `columnDiffFromVisibility` et `sortFromSortingState` depuis le schema.
- `dashboard-sort.ts` ne contient plus de cascade de fallback par string; les ids inconnus sont ignores avant accessor et les accessors connus viennent du schema.
- `dashboard-export.ts` genere le CSV depuis `sessionCsvColumns`.
- Ajout de `session-table-schema.test.ts` pour verifier alignement schema/colonnes rendues, round-trip URL visibility et ordre CSV.

Difficultes:
- Les objets `as const satisfies` conservent des unions exactes; un tableau interne elargi `sessionColumnEntries` est utilise pour lire les meta optionnelles `defaultVisible` / `hideable`.

Decisions:
- Garder le rendu cellule dans `session-columns.tsx`; le schema porte le contrat, pas les composants JSX.
- Garder les labels UI existants dans `session-columns.tsx` pour eviter un changement visuel large; le test d'alignement empeche le drift d'ids.
- Garder le CSV schema dans le meme module, car il partage le vocabulaire des colonnes mais reste un export dedie.

Fichiers touches:
- `apps/report/src/session-table-schema.ts`
- `apps/report/src/session-table-schema.test.ts`
- `apps/report/src/dashboard-search.ts`
- `apps/report/src/dashboard-sort.ts`
- `apps/report/src/session-columns.tsx`
- `apps/report/src/Dashboard.tsx`
- `apps/report/src/dashboard-export.ts`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd apps/report check`: passe.
- `bun run --cwd apps/report test`: passe.
- `bun run check`: passe.

Commit:
- `8526d4e refactor(report): add session table schema`

### Slice 14: Dashboard Model

Statut: implemente, verifie, committe

Objectif: sortir la logique calculatoire principale de `Dashboard.tsx` sans changer les signaux Solid ni le rendu.

Travail fait:
- Ajout de `apps/report/src/dashboard-model.ts`.
- Extraction des fonctions pures pour filtrer les rows timeline depuis un snapshot de filtres.
- Deplacement des primitives de filtre (`FilterSnapshot`, `createFilterSnapshot`, `matchesFilterSnapshot`) dans le modele.
- Extraction du filtrage par `DateBounds`, du tri de rows export/table, des summaries visibles et de la summary periode precedente.
- Extraction des groupes model/provider/harness/project depuis les rows timeline et bounds.
- Extraction du modele des metrics et des deltas de periode.
- `Dashboard.tsx` garde la composition des signaux, mais appelle les helpers model dans les memos.
- Ajout de `dashboard-model.test.ts` pour couvrir filtres, bounds date, previous period, metrics et ordre export trie sans mutation.

Difficultes:
- Les metrics restent formatees en strings car `MetricTile` consomme deja ce modele UI; extraire un modele numerique separerait le comportement visuel dans une slice plus large.

Decisions:
- Garder les Solid signals et handlers dans `Dashboard.tsx` pour eviter un changement comportemental large.
- Garder les gates par tab dans `Dashboard.tsx`; le model porte les calculs, pas la logique de navigation.
- Ne pas deplacer `Overview.tsx`; Slice 15 est dediee a ses calculs.

Fichiers touches:
- `apps/report/src/dashboard-model.ts`
- `apps/report/src/dashboard-model.test.ts`
- `apps/report/src/Dashboard.tsx`
- `apps/report/src/dashboard-filters.tsx`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd apps/report test`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run check`: passe.

Commit:
- `65a03c1 refactor(report): extract dashboard model`

### Slice 15: Overview Analytics Model

Statut: implemente, verifie, committe

Objectif: sortir les calculs analytiques de `Overview.tsx` pour garder le composant centre sur le rendu.

Travail fait:
- Ajout de `apps/report/src/overview-model.ts`.
- Extraction du modele calendar heatmap: aggregation par jour, seuils, semaines, labels mois, mode cost/sessions.
- Extraction du modele migration: buckets journaliers/hebdomadaires, series top models, other, paths SVG et total.
- Extraction du modele session shape: points times/cost, echelles log, ticks et harnesses.
- Extraction du modele punchcard: matrice weekday/hour, cout et densite sessions.
- Extraction des records: top session, longest session, busiest day et streak sur tout l'historique filtre.
- Extraction de `buildTopSessions`.
- `Overview.tsx` conserve les classes/design-system, le rendu SVG/JSX et les handlers de selection.
- Ajout de `overview-model.test.ts` pour couvrir heatmap, migration, session shape, punchcard, records et top sessions.

Difficultes:
- `Hero` et `TokenAnatomy` gardent encore de petits calculs de presentation, car ils sont tres proches de leurs segments visuels et ne bloquent pas le gain principal.
- Le modele migration retourne les paths, mais pas les classes de couleur; le mapping de style reste dans `Overview.tsx` pour eviter une dependance design-system dans le modele.

Decisions:
- Ne pas importer le design-system depuis `overview-model.ts`.
- Garder les fonctions de projection SVG (`xPct`, `yPct`) dans le modele, car elles sont le resultat calculatoire teste du chart.
- Garder `PUNCH_DAYS` et les ticks duration/cost dans le modele, car ce sont des constantes de donnees du chart.

Fichiers touches:
- `apps/report/src/overview-model.ts`
- `apps/report/src/overview-model.test.ts`
- `apps/report/src/Overview.tsx`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run --cwd apps/report test`: passe.
- `bun run --cwd apps/report check`: passe.
- `bun run check`: passe.

Commit:
- `86d93a1 refactor(report): extract overview model`

### Slice 16: Package Export Audit

Statut: implemente, verifie, committe

Objectif: rendre les Interfaces publiques inter-packages explicites et verifier que les imports workspace passent par les exports declares.

Travail fait:
- Audit des imports `@ai-usage/*` utilises par apps/packages.
- Confirmation que les subpaths publics actuels couvrent les usages reels des packages `core`, `local-collectors`, `reporting` et `design-system`.
- Ajout de `tools/check-public-package-exports.ts`.
- Le nouveau guardrail scanne les imports/export statiques et `import(...)` vers `@ai-usage/*`, puis verifie que le package et le subpath existent dans `package.json#exports`.
- Integration du guardrail dans le script root `lint`, apres Biome et `check-workspace-relative-paths`.
- Ajout de `docs/public-package-interfaces.md` pour documenter les Interfaces publiques et les guardrails.

Difficultes:
- Certains tags Effect contiennent des strings `@ai-usage/...`; le guardrail lit seulement les specifiers d'imports statiques/dynamiques pour eviter ces faux positifs.
- Le design-system importe son propre subpath public `@ai-usage/design-system/css`; ce pattern reste autorise car il passe par un export public.

Decisions:
- Ne pas reduire les exports existants dans cette slice: chaque subpath liste est actuellement utilise.
- Garder `@ai-usage/local-collectors/codex-history` public, car la CLI quota l'utilise directement comme exception explicite.
- Garder `biome` comme premier niveau de blocage `src`, et ajouter le script pour verifier les exports declares.

Fichiers touches:
- `tools/check-public-package-exports.ts`
- `package.json`
- `docs/public-package-interfaces.md`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun tools/check-public-package-exports.ts`: passe.
- `bun run lint`: passe.
- `bun run check`: passe.

Commit:
- `fbd7a56 chore(workspace): verify public package exports`

### Slice 17: Tooling Generated Ownership

Statut: implemente, verifie, en attente commit

Objectif: rendre explicite la propriete des fichiers generes Panda/TanStack/Nitro et aligner Turbo/Biome avec cette propriete.

Travail fait:
- Ajout des outputs Turbo pour `@ai-usage/report#build`: `dist/**`, `.output/**`, `styled-system/**`.
- Ajout des outputs Turbo pour `@ai-usage/report#check`: `styled-system/**`.
- Conservation des outputs existants `@ai-usage/design-system#build/check`: `styled-system/**`.
- Exclusion Biome de `apps/report/src/routeTree.gen.ts`.
- Ajout de `docs/generated-tooling-ownership.md`.
- Documentation du statut tracked de `routeTree.gen.ts` et du statut ignore de `styled-system/`, `dist/`, `.output/`, `.turbo/`.

Difficultes:
- `apps/report` scripts lancent encore `bun --filter @ai-usage/design-system build` directement. C'est redondant sous Turbo, mais necessaire pour les commandes package directes (`bun run --cwd apps/report check/test/build`) utilisees localement et dans les tests.
- `css-bundle.test.ts` execute un build report pendant `bun test`, mais ces outputs ne sont pas des artifacts contractuels du task Turbo `test`; ils restent ignores par git.

Decisions:
- Garder `routeTree.gen.ts` tracked, car son augmentation de module TanStack fait partie de la compilation app.
- Ne pas ajouter d'outputs generes au task global `test`; seuls `build` et `check` portent des outputs contractuels.
- Ne pas supprimer les builds directs design-system dans `apps/report/package.json` tant que les commandes directes doivent rester autonomes.

Fichiers touches:
- `turbo.json`
- `biome.json`
- `docs/generated-tooling-ownership.md`
- `docs/architecture-debt-implementation-log.md`

Checks:
- `bun run lint`: passe.
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
- Commit Slice 9: `70915cd refactor(collectors): report local history warnings`.
- Pick Slice 10: exposer les warnings dans payload, CLI et dashboard.
- Verifie Slice 10 avec `bun run --cwd packages/usage-core check`, `bun run --cwd packages/reporting check`, `bun run --cwd apps/cli check`, `bun run --cwd apps/report check`, `bun run --cwd apps/cli test`, `bun run --cwd apps/report test`, `bun run --cwd packages/reporting test`, `bun run check`.
- Commit Slice 10: `4a6da64 feat(report): surface local history warnings`.
- Pick Slice 11: centraliser le runtime report autour du chargement payload, refresh, injection et export.
- Verifie Slice 11 avec `bun run --cwd apps/report check`, `bun run --cwd apps/report test`, `bun run check`.
- Commit Slice 11: `1721d1b refactor(report): centralize payload runtime`.
- Pick Slice 12: partager le module d'inlining HTML entre export CLI et export browser.
- Verifie Slice 12 avec `bun run --cwd packages/usage-core check`, `bun run --cwd apps/cli check`, `bun run --cwd apps/report check`, `bun run --cwd apps/report test`, `bun run html export --since 1d`, `bun run check`.
- Commit Slice 12: `d3e60df refactor(report): share html export inliner`.
- Pick Slice 13: extraire le schema table session pour ids, visibility URL, sort et CSV.
- Verifie Slice 13 avec `bun run --cwd apps/report check`, `bun run --cwd apps/report test`, `bun run check`.
- Commit Slice 13: `8526d4e refactor(report): add session table schema`.
- Commit log correction: `0287ef5 docs: record committed architecture slices`.
- Pick Slice 14: extraire le modele pur de `Dashboard.tsx` sans changer le rendu.
- Verifie Slice 14 avec `bun run --cwd apps/report test`, `bun run --cwd apps/report check`, `bun run check`.
- Commit Slice 14: `65a03c1 refactor(report): extract dashboard model`.
- Commit Slice 14 log correction: `30e013b docs: record slice 14 commit`.
- Pick Slice 15: extraire les modeles analytiques purs de `Overview.tsx`.
- Verifie Slice 15 avec `bun run --cwd apps/report test`, `bun run --cwd apps/report check`, `bun run check`.
- Commit Slice 15: `86d93a1 refactor(report): extract overview model`.
- Commit Slice 15 log correction: `0017bf1 docs: record slice 15 commit`.
- Pick Slice 16: auditer les exports publics et ajouter un guardrail d'imports workspace.
- Verifie Slice 16 avec `bun tools/check-public-package-exports.ts`, `bun run lint`, `bun run check`.
- Commit Slice 16: `fbd7a56 chore(workspace): verify public package exports`.
- Commit Slice 16 log correction: `a1a3151 docs: record slice 16 commit`.
- Pick Slice 17: expliciter ownership des fichiers generes Panda/TanStack/Nitro/Turbo.
- Verifie Slice 17 avec `bun run lint`, `bun run check`.
