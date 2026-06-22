# Suivi implementation UI/UX refresh

Date: 2026-06-22

## Pick

- Ticket choisi pour cette passe: Ticket 1 - Contrats `report-core`.
- Raison: ce ticket pose les types, la normalisation de lineage et la provenance domaine. Les tickets pipelines, collecteurs et UI en dependent.
- Ticket suivant pris apres validation locale: Ticket 2 - Brancher la normalisation dans les pipelines report.
- Ticket suivant pris apres validation pipelines: Ticket 3 - Collecteurs lineage + titres.
- Suite apres commit `cbbceb4`: Ticket 4 - Modele campagne dashboard.
- Suite apres validation modele: Ticket 5 - Table Sessions groupee.

## Journal

- 2026-06-22: lecture du plan `.agent-memory/processed/ui-ux-refresh-plan.md`.
- 2026-06-22: `git status --short` montre une modification preexistante dans `docs/future-work.md`; elle est hors perimetre et ne sera pas modifiee.
- 2026-06-22: inspection de `packages/report-core`; ajout prevu dans les types existants plutot qu'un contrat parallele.
- 2026-06-22: implementation des modules purs `session-lineage` et `provenance`, plus tests unitaires.
- 2026-06-22: `bun --filter @ai-usage/report-core test` et `check` passent apres correction du test `costQuota`.
- 2026-06-22: branchement de `normalizeSessionLineage` avant preparation des reports CLI, local, stored et merged.
- 2026-06-22: correction de la preservation du lineage dans les snapshots et merge bundles; le store garde le JSON complet, mais les serializeurs perdaient `parentSourceSessionId`.
- 2026-06-22: `report-core` et `report-data` repassent apres correction serialization lineage.
- 2026-06-22: enrichissement des collecteurs Codex, Claude, OpenCode et Cursor avec `titleSource`; propagation parent direct pour Codex, Claude agent et OpenCode.
- 2026-06-22: ajout des tests collecteurs pour Codex enfant, Claude agent, OpenCode parent/classifier, Cursor `titleSource`.
- 2026-06-22: ajout du modele campagne web (`CampaignView`, totaux visibles/all, items/table rows groupees) avec tests.
- 2026-06-22: ajout du search state `campaigns`, toggle table, sous-lignes TanStack expanded, badge `Campaign · N/M sessions`.

## Decisions

- Implementer d'abord les contrats purs dans `packages/report-core`, avec tests unitaires locaux avant branchement applicatif.
- Garder la normalisation sans mutation in-place et preserve-order, comme demande par le plan.
- `costQuota` absent signifie que la row ne declare pas de subscription value; `costQuota: null` signifie valeur declaree mais inconnue.
- Cote CLI, `prepareUsageReport` devient un wrapper local pour garantir que JSON/CSV/payload/table partagent la normalisation.
- Les caches collecteurs sont invalides en sortie de contrat, donc leurs versions sont augmentees.
- Scope commit: Tickets 1, 2 et 3 du plan. Les tickets 4 a 8 restent a faire dans une passe UI separee.
- Nouveau scope commit: Tickets 4 et 5. Les tickets 6 a 8 restent a faire.

## Difficultes

- `rg` n'est pas disponible dans l'environnement; les recherches utiliseront `find`/`grep` si necessaire.
- Premier run tests/check: echec attendu autour de `costQuota: undefined`; avec `exactOptionalPropertyTypes`, ce cas declare quand meme une propriete presente. Le test est corrige pour verifier une cle absente.
- Premier run `report-data`: la normalisation produisait root=self apres store/snapshot, car `parentSourceSessionId` etait perdu avant stockage.

## Validation

- OK: `bun --filter @ai-usage/report-core test`.
- OK: `bun --filter @ai-usage/report-core check`.
- A faire: tests/check report-data et CLI apres branchement.
- OK: `bun --filter @ai-usage/report-data test`.
- OK: `bun --filter @ai-usage/report-data check`.
- OK: `bun --filter @ai-usage/cli test`.
- OK: `bun --filter @ai-usage/cli check`.
- OK: `bun --filter @ai-usage/local-collectors test`.
- OK: `bun --filter @ai-usage/local-collectors check`.
- OK: `bun run check` apres formatage. Warnings Biome non bloquants: schema 2.4.16 vs CLI 2.5.0 et gros fichiers Nix store.
- OK: `bun --filter @ai-usage/cli test` apres formatage.
- OK: rerun `bun --filter @ai-usage/local-collectors test`.
- OK: rerun `bun --filter @ai-usage/local-collectors check`.
- OK: `bun --filter @ai-usage/web test -- dashboard-search dashboard-model`.
- OK: `bun --filter @ai-usage/web check`.
- OK: `bun --filter @ai-usage/web test`.
- OK: `bun run check` apres branchement web. Warnings Biome non bloquants identiques.
- OK: rerun `bun --filter @ai-usage/web test -- dashboard-search dashboard-model` apres formatage.
- OK: rerun `bun --filter @ai-usage/web check` apres formatage.
- OK: serveur dev Vite demarre sur `http://127.0.0.1:3000/`.
- OK: `curl -I http://127.0.0.1:3000/` retourne HTTP 200.
- OK: rerun final `bun run check` apres revue.

## Documentation

- Ce fichier trace le pick, les decisions, difficultes et validations.
- Implementation terminee pour:
  - Ticket 1: contrats `report-core`, normalisation lineage, provenance metrique.
  - Ticket 2: branchement normalisation CLI/report-data local, stored, merged.
  - Ticket 3: collecteurs Codex, Claude, OpenCode, Cursor enrichis en lineage/titres.
- Reste hors scope de ce commit: modele campagne web, table groupee, drawer campagne, provenance UI, overview group-aware.
- Implementation terminee pour:
  - Ticket 4: modele campagne dashboard, totaux visibles/all, tri group-aware, parent contextuel.
  - Ticket 5: toggle URL `campaigns`, table groupee, sous-lignes expand, CSV atomique preserve.
- Reste hors scope de ce commit: drawer campagne, provenance UI, overview group-aware.

## Commit

- Commit precedent: `cbbceb4 Add usage lineage and provenance contracts`.
- A faire: commit scope Tickets 4-5 uniquement, en excluant `docs/future-work.md`.
