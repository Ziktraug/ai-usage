# Plan 025: Rendre Session Analysis vérifiable de la source jusqu'à l'UI

> **Instructions au coordinateur** : ce fichier est un plan maître composé de
> cinq lots livrables. Chaque agent doit lire le plan entier, puis n'implémenter
> que le lot qui lui est attribué. Le coordinateur est le seul à modifier le
> statut dans `plans/README.md`. Chaque agent doit exécuter toutes les
> vérifications de son lot et remettre son commit, ses résultats et tout écart
> constaté ; il ne doit ni pousser ni ouvrir de PR sans demande explicite.
>
> **Contrôle de dérive à exécuter en premier** :
>
> `git diff --stat cb9bc22..HEAD -- packages/local-collectors/package.json packages/local-collectors/src packages/report-core/src/session-detail.ts packages/report-core/src/session-query.ts packages/report-data/src/revision-query-runner.ts packages/report-data/src/session-query-materialization.ts packages/report-data/src/session-query-sqlite.ts apps/web/src apps/web/e2e docs/architecture.md docs/public-package-interfaces.md docs/session-analysis-sources.md`
>
> Si un fichier de portée a changé depuis `cb9bc22`, comparer les extraits de
> « Current state » au code vivant. Si une interface, un invariant de
> confidentialité, un format de source ou le protocole exact-revision a changé,
> STOP : mettre à jour ce plan avant de coder.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: L, à livrer en cinq lots
- **Risk**: HIGH
- **Depends on**: plans 016, 017, 018 et 024, tous DONE
- **Category**: bug, tests, tech-debt, UX, docs
- **Planned at**: commit `cb9bc22`, 2026-07-19
- **Suggested integration branch**: continuer la branche courante ou créer
  `fix/025-session-analysis-trust` ; ne pas pousser sans instruction

## Why this matters

L'UI actuelle mélange trois informations différentes sous une apparence
d'alerte : une trace locale lue à la demande, une analyse limitée à la racine
d'une campagne et la confidentialité des prompts. Seule une divergence
constatée ou une métrique partielle doit affecter la confiance. Le message
« may be newer » existe aujourd'hui parce que l'application ne sait pas
vérifier que la ligne de la révision immuable et la trace locale courante
décrivent la même projection.

Deux problèmes rendent ce défaut durable : le navigateur choisit directement
la provenance locale à relire, et OpenCode dérive séparément les mêmes tokens,
modèles, coûts, durées et associations pour le rapport et pour le détail. Les
tests traversent rarement tout le chemin depuis de vrais fichiers de harness
jusqu'à la requête finale. Ce plan crée une preuve déterministe à chaque seam,
puis simplifie l'UI pour que son niveau d'alerte corresponde exactement à ce
que le système sait.

## Diagnostic et décision architecturale

Le warning permanent n'est pas souhaité sous sa forme actuelle. Il ne prouve
pas que les données sont fausses ; il compense une interface de cohérence
absente. La correction ne consiste donc pas seulement à changer le texte.

La décision retenue est :

1. Le navigateur demande une analyse avec seulement `{ revision, rowId }`.
2. Le serveur résout dans le `sessions.sqlite` de cette révision une ancre
   non sensible : machine, harness, session source et faits de projection.
3. L'adapter local relit la source courante et retourne à la fois le détail UI
   et les mêmes faits de projection.
4. Une fonction pure compare ces deux projections et retourne
   `matches-report`, `differs-from-report` ou `cannot-compare`.
5. L'UI ne rend une alerte de cohérence que pour `differs-from-report`.

Le statut ne doit jamais être nommé `source-newer` : une différence peut venir
d'une source enrichie, d'un parser corrigé ou d'une ancienne révision. Le
système observe une divergence ; il ne peut pas en prouver la causalité.

## Invariants non négociables

1. Les révisions de rapport restent immuables et sont toujours lues sous lease
   par le runner exact-revision existant.
2. Les prompts détaillés restent locaux, chargés à la demande, bornés et absents
   des révisions, snapshots, merge bundles et exports.
3. Le navigateur ne fournit plus `machineId`, `harnessKey` ni
   `sourceSessionId` à l'endpoint ; ces valeurs viennent de la révision.
4. Aucun chemin local, contenu de prompt ou erreur brute ne doit entrer dans
   l'ancre révisionnée ou dans un fingerprint.
5. `matches-report` signifie « les faits comparables de projection sont
   identiques », pas « la source contient toute la vérité ».
6. `partial`, `usageUnavailable`, pricing inconnu et texte tronqué restent des
   limitations par métrique. Il n'existe pas de badge global « data quality ».
7. Une campagne garde ses totaux visibles séparés de son nombre total. Une
   analyse de campagne vise explicitement sa session racine.
8. Les tests golden utilisent des attentes littérales indépendantes. Le builder
   de fixture ne calcule jamais les résultats attendus avec les fonctions de
   production qu'il teste.
9. Les protections existantes de lecture locale — no-follow, UTF-8 strict,
   transactions SQLite read-only, limites de lignes et d'octets — ne sont pas
   affaiblies.
10. Playwright valide le câblage et la sémantique visuelle ; les calculs
    multi-harness restent couverts sous le navigateur par des tests
    déterministes.

## Current state

### Le rapport est révisionné, le détail ne l'est pas

- `packages/report-core/src/session-query.ts:83-91` impose `revision` sur une
  requête de sessions.
- `packages/report-core/src/session-detail.ts:16-20` accepte actuellement :

  ~~~ts
  export interface SessionDetailRequest {
    harnessKey: string;
    machineId: string;
    sourceSessionId: string;
  }
  ~~~

- `apps/web/src/session-detail-client.ts:18-33` construit cette requête depuis
  la provenance de la ligne affichée.
- `apps/web/src/server/session-detail.server.ts:43-64` valide la machine puis
  relit directement l'historique courant.
- `packages/report-data/src/session-query-materialization.ts:88-93` stocke déjà
  `row_id` et `source_row_json` dans chaque révision. Il n'est donc pas
  nécessaire d'ajouter une seconde copie de la ligne ou un nouveau manifest.

### Le runner exact-revision est déjà le bon seam

- `apps/web/src/server/revision-query-runner.server.ts` possède le lease, le
  subprocess borné, le parsing strict et la distinction
  `RevisionExpired` / `QueryFailed`.
- `packages/report-data/src/revision-query-runner.ts:20-45` et
  `packages/report-data/src/session-query-sqlite.ts:710-747` dispatchent
  actuellement `sessions`, `campaign-children` et `neighbors`.
- Le nouveau lookup d'ancre doit être un kind supplémentaire de ce protocole,
  pas un accès SQLite direct depuis Nitro et pas un nouveau runner parallèle.

### La campagne est aplatie en une fausse « session »

- `packages/report-core/src/session-query.ts:198-200` possède déjà une union
  `SessionPageItem` discriminée.
- Mais `sessionCampaignDisplayRow`, lignes 1140-1193, clone la racine et remplace
  ses métriques par `visibleTotals` tout en gardant son identité de racine.
- `apps/web/src/session-query-client.ts:126-140` jette ensuite le discriminant
  et retourne seulement des lignes.
- `apps/web/src/session-drawer.tsx:286-290` affirme que le résumé combine
  `campaignTotalCount` rollouts, alors que les chiffres affichés utilisent
  `campaignVisibleCount` quand des filtres masquent des enfants.

Le plan ne transforme pas toute la table en une nouvelle union. Il introduit un
type discriminé au seam de sélection/analyse, là où la confusion devient
dangereuse, et conserve le format de ligne actuel pour la table.

### Les notices n'expriment pas leur sémantique

`apps/web/src/session-analysis.tsx` rend actuellement :

- lignes 417-420 : « Live local trace » sans divergence détectée ;
- lignes 421-435 : de vraies limitations partielles ;
- lignes 436-443 : la portée racine avec `warningNotice` ;
- lignes 505-511 : la confidentialité comme grand encart ;
- lignes 512-516 : une vraie troncature.

La documentation est plus précise que l'UI :

- `docs/session-analysis-sources.md:40-45` réserve l'orange `!` aux vrais
  problèmes de qualité et précise qu'un marqueur concerne une métrique ;
- `docs/future-work.md:43-47` interdit un drapeau global de qualité ;
- `docs/session-analysis-sources.md:276-297` définit la frontière de
  confidentialité des prompts.

### OpenCode a deux propriétaires de la même dérivation

- `packages/local-collectors/src/collectors/opencode.ts:195-393` parse et agrège
  les messages pour le rapport.
- `packages/local-collectors/src/opencode-history.ts:190-492` réimplémente
  tokens, reasoning-as-output, modèles, intervalles, coûts et parenté pour le
  détail.
- `packages/local-collectors/src/codex-history.ts:763` montre le modèle à
  suivre : un parseur commun sert la projection rapport et la capture détaillée.

Les requêtes SQL « toutes les sessions » et « une session bornée » peuvent
rester distinctes. Les règles sémantiques, elles, doivent avoir un seul
propriétaire.

### Les tests verticaux sont insuffisants

- `packages/report-data/src/source-adapters.test.ts:26-119` traverse un vrai
  fichier uniquement pour une session Claude simple.
- `packages/local-collectors/src/test-memory-storage.ts:142-173` retourne des
  lignes préparées sans exécuter le SQL ; les tests OpenCode/Cursor peuvent donc
  manquer une divergence de schéma ou de `json_extract`.
- `apps/web/src/report-runtime.ts:13-20` sert un payload démo aux E2E de
  développement et contourne les collecteurs.
- `apps/web/e2e/production-server.ts:6-75` seed 205 JSONL Codex réels, mais
  `production-report.spec.ts:222-292` vérifie surtout pagination, révision et
  navigation.

## Architecture cible

~~~text
fixtures réelles
  └─ collecteurs Claude/Codex/OpenCode/Cursor
       └─ usage-store
            └─ payload stocké
                 └─ sessions.sqlite immuable
                      └─ session-detail-anchor(revision, rowId)
                           ┐
                           ├─ compareSessionProjectionFacts ── consistency
source locale courante     │
  └─ read*SessionAnalysis ─┘
       ├─ detail local (prompts inclus, jamais persistés)
       └─ projectionFacts (sans prompts ni paths)

SessionDrawerTarget(kind=session | campaign-root)
  + SessionDetailResponse(consistency)
  └─ modèle de présentation typé
       └─ UI : metadata neutre ou vraie alerte ciblée
~~~

### Contrats cibles

Les noms ci-dessous sont prescriptifs. Les détails d'implémentation privés
peuvent varier, pas les discriminants ni leur sens.

Dans `packages/report-core/src/session-detail.ts` :

~~~ts
export interface SessionDetailRequest {
  revision: string;
  rowId: string;
}

export interface SessionProjectionModelFacts {
  model: string;
  tokens: SessionDetailTokenCounts;
}

export interface SessionProjectionFacts {
  calls: number;
  durationMs: number | null;
  modelSegments: SessionProjectionModelFacts[] | null;
  partial: boolean;
  tokens: SessionDetailTokenCounts | null;
  tools: number;
  turns: number;
}

export interface SessionDetailReportAnchor {
  harnessKey: string | null;
  machineId: string | null;
  projection: SessionProjectionFacts;
  sourceSessionId: string | null;
}

export interface SessionDetailAnchorResult {
  anchor: SessionDetailReportAnchor | null;
  requestFingerprint: string;
  revision: string;
}

export interface LocalSessionAnalysis {
  detail: SessionDetail;
  projection: SessionProjectionFacts;
}

export type SessionDetailComparableField =
  | 'calls'
  | 'duration'
  | 'model-attribution'
  | 'coverage'
  | 'tokens'
  | 'tools'
  | 'turns';

export type SessionDetailConsistency =
  | {
      checkedFields: SessionDetailComparableField[];
      status: 'matches-report';
    }
  | {
      checkedFields: SessionDetailComparableField[];
      differingFields: SessionDetailComparableField[];
      status: 'differs-from-report';
    }
  | {
      checkedFields: SessionDetailComparableField[];
      reason: 'insufficient-comparable-facts';
      status: 'cannot-compare';
    };

export type SessionDetailResponse =
  | {
      consistency: SessionDetailConsistency;
      detail: SessionDetail;
      revision: string;
      status: 'available';
    }
  | {
      message: string;
      reason:
        | 'history-unavailable'
        | 'not-found'
        | 'not-local'
        | 'report-provenance-unavailable'
        | 'report-row-not-found'
        | 'revision-expired'
        | 'unsupported';
      status: 'unavailable';
    };
~~~

Règles de `SessionProjectionFacts` :

- `tokens` vaut `null` seulement pour une ligne `usageUnavailable` ;
- `modelSegments` est trié canoniquement par modèle et exclut le coût ;
- une ligne multi-modèle sans attribution fiable utilise `null`, jamais une
  attribution inventée vers le modèle dominant ;
- `durationMs` garde la sémantique active du rapport, pas le span affiché dans
  le détail ;
- `calls`, `turns`, `tools` et `partial` reproduisent exactement la projection
  rapport du harness ;
- les coûts, timestamps de prompt, titres, paths et labels ne participent pas à
  cette comparaison. Les coûts restent testés dans le golden vertical, car un
  tarif peut changer sans que l'historique source change.

Règles de présence de l'ancre :

- `anchor: null` signifie exclusivement que `row_id` n'existe pas dans la
  révision demandée et devient `report-row-not-found` ;
- une ligne existante produit toujours une ancre, même sans `source` ; ses
  champs de provenance manquants valent `null` ;
- une ancre dont `harnessKey`, `machineId` ou `sourceSessionId` vaut `null`
  devient `report-provenance-unavailable` et n'autorise aucune lecture locale ;
- un `harnessKey` non nul mais non supporté devient `unsupported`, et une
  machine non locale devient `not-local`.

`compareSessionProjectionFacts(report, local)` :

- construit `checkedFields` et `differingFields` dans l'ordre fixe du type
  `SessionDetailComparableField` ;
- ne compare jamais des flottants de coût ;
- ne transforme jamais une divergence en exception.

La matrice de comparaison est normative :

| Champ | Quand il est dans `checkedFields` | Égalité |
| --- | --- | --- |
| `calls` | `tokens !== null` des deux côtés | entier strictement égal |
| `duration` | sauf si les deux `durationMs` sont `null` | `null` contre nombre diverge ; sinon égalité stricte |
| `model-attribution` | les deux `modelSegments` sont non null | tableaux canoniques profondément égaux |
| `coverage` | toujours | tuple `(partial, tokens !== null)` strictement égal |
| `tokens` | les deux `tokens` sont non null | cinq compteurs profondément égaux |
| `tools` | `tokens !== null` des deux côtés | entier strictement égal |
| `turns` | toujours | entier strictement égal |

L'algorithme de statut est également normatif :

1. si au moins un champ vérifié diffère, retourner `differs-from-report` ;
2. sinon, si `tokens` appartient à `checkedFields`, retourner
   `matches-report` ;
3. sinon, retourner `cannot-compare` avec
   `reason: 'insufficient-comparable-facts'` et conserver dans
   `checkedFields` les champs effectivement vérifiés.

Ainsi, deux projections `usageUnavailable` identiques ne produisent jamais un
faux match global : durée, couverture et tours peuvent être vérifiés, mais le
statut reste `cannot-compare`. Si un seul côté a un usage disponible,
`coverage` diverge. Une attribution modèle legacy absente des deux côtés est
simplement exclue ; des tokens disponibles permettent tout de même un match sur
les autres métriques.

Dans `apps/web/src/session-analysis-target.ts` :

~~~ts
export type SessionAnalysisTarget =
  | {
      kind: 'session';
      reportRowId: string;
      summaryRow: DashboardRow;
    }
  | {
      campaignKey: string;
      kind: 'campaign-root';
      reportRowId: string;
      summaryRow: DashboardRow;
      totalCount: number;
      visibleCount: number;
    };
~~~

`SessionDrawer` reçoit ce target et une révision. Il n'infère plus la portée à
partir de `campaignTotalCount !== undefined`.

## Alternatives explicitement rejetées

- **Envoyer la provenance et un hash depuis le navigateur** : rejeté. Le
  navigateur resterait propriétaire d'une donnée que le serveur peut résoudre
  depuis la révision, et le hash du client ne prouverait rien.
- **Persister toute la timeline dans la révision** : rejeté. Cela augmente
  fortement les artefacts et risque d'y faire entrer les prompts privés.
- **Ajouter un fingerprint opaque à côté de `source_row_json`** : rejeté pour
  ce lot. La ligne source existe déjà dans l'artefact ; dériver une petite ancre
  au lookup évite une seconde vérité et une migration de schéma.
- **Afficher « source newer » quand les valeurs diffèrent** : rejeté. La
  divergence ne permet pas d'identifier sa cause.
- **Créer une matrice Playwright pour quatre harnesses** : rejeté. Elle serait
  lente et redondante. Un golden multi-harness sous le navigateur et un smoke
  production UI donnent une meilleure localisation des échecs.
- **Refondre toutes les lignes de table en union discriminée** : reporté. Le
  discriminant `SessionPageItem` existe déjà ; le seam à sécuriser maintenant
  est la sélection envoyée au drawer/analyse.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install check | `bun install --frozen-lockfile` | exit 0, lockfile unchanged |
| Core/detail | `bun test packages/report-core/src/session-detail.test.ts` | all tests pass |
| Collectors | `bun test packages/local-collectors/src/codex-history.test.ts packages/local-collectors/src/opencode-history.test.ts packages/local-collectors/src/db-collectors.test.ts` | all tests pass |
| Report integration | `bun test packages/report-data/src/source-adapters.test.ts packages/report-data/src/session-query-runner.test.ts` | all tests pass |
| Web detail | `bun test apps/web/src/session-analysis.test.ts apps/web/src/session-analysis.render.test.tsx apps/web/src/session-detail-client.test.ts apps/web/src/server/session-detail.server.test.ts` | all tests pass |
| Format/check | `bun run check` | exit 0, no findings |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |
| Dev browser | `bun run test:e2e` | all tests pass |
| Production browser | `bun run test:e2e-production` | all tests pass |
| Production listener | `bun run test:web-production` | exit 0 |
| Whitespace | `git diff --check cb9bc22...HEAD` | no output |

Le dépôt utilise Ultracite. Faire des corrections ciblées pendant chaque lot ;
le coordinateur exécute `bun x ultracite fix` seulement après avoir vérifié que
le worktree ne contient pas de changements étrangers.

## Scope

### In scope

- `packages/local-collectors/package.json` ;
- un export test-only
  `packages/local-collectors/src/test-fixtures/harness-home.ts` et ses tests ;
- `packages/local-collectors/src/collectors/opencode.ts`,
  `opencode-history.ts`, un module profond interne
  `opencode-session-facts.ts`, `codex-history.ts` et leurs tests ;
- `packages/report-core/src/session-detail.ts` et
  `session-detail.test.ts` ;
- `packages/report-core/src/session-query.ts` et ses tests uniquement si
  nécessaire pour adapter la sélection de campagne, sans changer la pagination ;
- `packages/report-data/src/revision-query-runner.ts`,
  `session-query-sqlite.ts`, leurs tests et un nouveau test vertical ;
- `apps/web/src/server/revision-query-runner.server.ts`,
  `session-detail.server.ts`, `report-payload.ts` et leurs tests ;
- `apps/web/src/session-detail-client.ts`,
  `session-analysis-target.ts`, `session-analysis-presentation.ts`,
  `session-analysis.tsx`, `session-analysis.render.test.tsx`,
  `session-drawer.tsx`,
  `session-query-client.ts`, `dashboard.tsx` et tests associés ;
- `apps/web/e2e/production-server.ts` et
  `production-report.spec.ts` pour un seul smoke de câblage ;
- `docs/architecture.md`, `docs/public-package-interfaces.md` et
  `docs/session-analysis-sources.md` ;
- `plans/025-make-session-analysis-trustworthy-end-to-end-log.md` et l'index.

### Out of scope

- changement du schéma de `usage-store` ou de l'identité des lignes ;
- ajout de prompts, timeline ou paths aux snapshots/révisions/exports ;
- recalcul ou migration des anciennes révisions déjà publiées ;
- modification des tarifs modèles ou du sens de `costApprox` ;
- support du drawer détaillé pour Claude ou Cursor ;
- refonte globale de `SessionPresentationRow`, du tableau ou de TanStack Table ;
- nouveau scheduler, nouveau cache global ou accès SQLite direct dans le
  client/Nitro ;
- changement des cadences source, de la publication SSE ou du coordinateur de
  révision du plan 018 ;
- modification du design-system si les styles existants `pill`, `muted`,
  `notice` et `warningNotice` suffisent.

## Répartition entre agents et ordre d'intégration

| Agent | Lot | Ownership exclusif | Dépend de | Peut être parallèle |
| --- | --- | --- | --- | --- |
| A | Fixtures et golden vertical | test fixture + tests report-data | baseline | non, livre d'abord |
| B | Faits de projection et OpenCode partagés | report-core projection facts + local-collectors analysis API | A | non |
| C | Contrat exact-revision | report-core consistency, report-data runner, web server/client | B | non |
| D | Target et présentation UI | dashboard/drawer/analysis models et composants | C | non |
| E | Intégration finale | E2E production, docs, gates, log/index | A-D | non |

Règles de coordination :

1. A crée l'API de fixture et livre un commit vert.
2. B repart du commit de A, ajoute d'abord les types/fonctions de projection
   purs dans `session-detail.ts`, puis migre Codex/OpenCode.
3. C repart du commit de B et possède ensuite les changements de contrat,
   runner, serveur et client. Cette séquence évite de dupliquer temporairement
   `SessionProjectionFacts` entre packages.
4. D commence seulement après C intégré et relit les types réels ; il ne change
   pas le protocole serveur pour faciliter le JSX.
5. E ne corrige pas silencieusement une sémantique métier. Si un golden échoue,
   il renvoie le lot au propriétaire concerné.

## Git workflow

- Préserver tout changement utilisateur non lié.
- Un commit par lot, au style impératif observé dans le dépôt :
  - `Add vertical harness report fixtures`
  - `Unify OpenCode session projection facts`
  - `Bind session detail to report revisions`
  - `Clarify session analysis trust signals`
  - `Cover session analysis end to end`
- Ne pas mélanger formatage global ou upgrades de dépendances.
- Ne pas pousser et ne pas ouvrir de PR sans instruction.
- Chaque agent remet : SHA, fichiers modifiés, commandes exactes, résultats,
  écarts/STOP rencontrés.

## Work package 0 — Baseline et journal d'exécution

**Owner** : coordinateur.

### Step 0.1 — Vérifier le worktree et créer le journal

Exécuter :

~~~sh
git status --short --branch
git rev-parse --short HEAD
git diff --stat cb9bc22..HEAD -- \
  packages/local-collectors packages/report-core packages/report-data apps/web docs
~~~

Créer `plans/025-make-session-analysis-trustworthy-end-to-end-log.md` avec :

- SHA de départ ;
- table A-E avec `TODO / IN PROGRESS / DONE / BLOCKED` ;
- pour chaque lot : commit, commandes, durées et résultat ;
- toute différence golden observée, avec source et projection affectée ;
- résultat final de chaque gate.

**Verify** : `git status --short` → seulement le nouveau log et les changements
de plan attendus avant le début de l'implémentation.

### Step 0.2 — Geler la baseline

~~~sh
bun test \
  packages/report-core/src/session-detail.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/local-collectors/src/opencode-history.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/report-data/src/source-adapters.test.ts \
  packages/report-data/src/session-query-runner.test.ts \
  apps/web/src/session-analysis.test.ts \
  apps/web/src/session-detail-client.test.ts \
  apps/web/src/server/session-detail.server.test.ts
~~~

**Expected** : exit 0. Si la baseline échoue, consigner l'échec et STOP ; ne pas
l'attribuer au plan.

## Work package 1 — Seeder de vrais homes et figer le résultat vertical

**Owner** : Agent A.

### Step 1.1 — Ajouter un builder de fixtures possédé par les harnesses

Créer
`packages/local-collectors/src/test-fixtures/harness-home.ts` et l'export
test-only `./test-fixtures/harness-home` dans
`packages/local-collectors/package.json`.

API minimale :

~~~ts
export type HarnessFixtureKey = 'claude' | 'codex' | 'cursor' | 'opencode';

export const HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL =
  'PRIVATE_DETAIL_PROMPT_SENTINEL_025';

export interface SeededHarnessHome {
  ids: {
    claude: string;
    codexChild: string;
    codexRoot: string;
    cursor: string;
    opencode: string;
  };
  paths: {
    codexRootRollout: string;
    cursorDatabase: string;
    opencodeDatabase: string;
  };
  seededHarnesses: readonly HarnessFixtureKey[];
}

export interface SeedHarnessHomeOptions {
  codexSessionCount?: number;
  harnesses?: readonly HarnessFixtureKey[];
}

export const seedHarnessHome = async (
  home: string,
  options?: SeedHarnessHomeOptions,
): Promise<SeededHarnessHome>;

export const appendCodexRootUsage = async (
  fixture: SeededHarnessHome,
): Promise<void>;
~~~

Le builder reçoit un répertoire déjà créé ; il ne crée ni ne supprime lui-même
le temp root. Tous les timestamps sont ISO fixes en juillet 2026. Les IDs et
prompts sont synthétiques.

Le contrat de sous-ensemble est explicite : `ids` et `paths` contiennent
toujours les mêmes valeurs déterministes pour les quatre harnesses, mais seuls
les artefacts nommés dans `seededHarnesses` existent sur disque. Par défaut,
les quatre harnesses sont seedés. Avec `harnesses: ['codex']`, les paths
OpenCode/Cursor sont des paths attendus mais inexistants et aucun JSONL Claude
n'est créé. `appendCodexRootUsage` rejette avec une erreur descriptive si
`codex` n'est pas dans `seededHarnesses`.

Il doit écrire :

- Claude : un JSONL avec deux messages assistant de modèles différents, deux
  tours, un outil, cache read/write et titre dérivé ;
- Codex : un root et un child liés, deux tâches, changement de modèle, snapshots
  cumulatifs, un tool call, un intervalle ouvert/partiel séparé et des prompts ;
  placer `HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL` dans un corps de prompt qui
  n'est jamais choisi comme titre ;
  reprendre les formes d'événements prouvées dans
  `codex-history.test.ts:582-791` et les cas de lineage des lignes 1450+ ;
- OpenCode : une vraie base SQLite avec tables minimales `session`, `message`
  et `part`. Inclure deux providers/modèles, reasoning, cache read/write, deux
  intervalles qui se chevauchent, un parent humain, un parent interne et un
  outil ;
- Cursor : une vraie `state.vscdb` avec `cursorDiskKV`, un composer, des bubbles
  user/assistant et compteurs partiels. Ajouter un CSV configuré seulement si
  nécessaire pour couvrir la réconciliation multi-modèle ; ne pas simuler le
  SQL avec `TestMemoryStorage`.

Créer `harness-home.test.ts` qui vérifie :

- les fichiers attendus existent ;
- `PRAGMA integrity_check` retourne `ok` pour les deux bases ;
- les IDs sont stables ;
- un seed Codex-only retourne `seededHarnesses: ['codex']` et ne crée aucun
  artefact Claude/OpenCode/Cursor malgré leurs paths déterministes ;
- `codexSessionCount: 205` produit 205 sessions Codex totales sans changer
  le scénario racine.

**Verify** :

~~~sh
bun test packages/local-collectors/src/test-fixtures/harness-home.test.ts
~~~

**Expected** : tous les tests passent ; aucun fichier n'est écrit hors du temp
home du test.

### Step 1.2 — Ajouter le golden source → store → payload → SQLite

Créer
`packages/report-data/src/session-report-pipeline.integration.test.ts`.
Le test doit :

1. créer un temp home et `createLocalHistoryStorage(home)` ;
2. écrire la machine fixe avec `writeMachineConfig` ;
3. appeler `seedHarnessHome(home)` ;
4. construire `createScheduledSourceRegistry` avec la machine fixe et
   `codexLiveAvailable: () => false` ;
5. exécuter explicitement, dans cet ordre,
   `claude.sessions`, `codex.sessions`, `opencode.sessions` et
   `cursor.sessions` ;
6. lire `queryReportRows({ dbPath: usageStorePath(home) })` ;
7. créer `createStoredReportPayload` avec `generatedAt` fixe ;
8. matérialiser un `sessions.sqlite` dans un répertoire `0700` ;
9. ouvrir ce SQLite en read-only et comparer
   `executeMaterializedSessionQuery('sessions', ...)` à
   `projectSessionPage(payload.rows, request)` ;
10. vérifier une projection littérale compacte par harness.

La projection littérale doit inclure :

- `sourceSessionId`, parent/root lineage et campagne Codex ;
- `date`, `endDate` et `durationMs` ;
- `tokIn`, `tokOut`, `tokCr`, `tokCw`, `tokenTotal` ;
- `models` et chaque `modelSegment` sans arrondir les tokens ;
- `costApprox` avec `toBeCloseTo`, `costKnown` et `costActual` ;
- `turns`, `tools`, `partial` et `usageUnavailable` ;
- les totaux de campagne visibles et complets ;
- l'invariant somme des segments = agrégat de ligne ;
- le filtre sur un modèle secondaire ;
- l'absence d'un second corps de prompt détaillé, non utilisé comme titre, dans
  `JSON.stringify(payload)` et dans `source_row_json`. Un `sessionLabel`
  prompt-derived reste autorisé par le contrat documenté.

Les attentes restent dans le test sous forme de littéraux. Le builder n'exporte
que IDs et paths, jamais les résultats attendus.

**Verify** :

~~~sh
bun test \
  packages/local-collectors/src/test-fixtures/harness-home.test.ts \
  packages/report-data/src/session-report-pipeline.integration.test.ts
~~~

**Expected** : exit 0, mêmes résultats sur deux exécutions consécutives. Si une
valeur actuelle contredit directement les événements seedés, ne pas bénir la
valeur : consigner le diff factuel et l'assigner à B ou au harness concerné.

### Step 1.3 — Prouver les vraies requêtes SQLite OpenCode/Cursor

Créer `packages/local-collectors/src/db-collectors.integration.test.ts` et
couvrir au minimum :

- OpenCode nominal multi-modèle ;
- OpenCode ligne JSON invalide isolée sans perdre la voisine valide ;
- Cursor composer avec tokens partiels ;
- Cursor DB + CSV réconciliés sans double comptage.

Garder `TestMemoryStorage` pour les combinaisons rapides existantes ; ces tests
réels sont une couche de contrat, pas un remplacement de toute la suite.

**Verify** :

~~~sh
bun test packages/local-collectors/src/db-collectors.integration.test.ts \
  packages/report-data/src/session-report-pipeline.integration.test.ts
~~~

**Expected** : toutes les requêtes s'exécutent contre Bun SQLite et passent.

## Work package 2 — Donner un seul propriétaire aux faits OpenCode

**Owner** : Agent B.

### Step 2.1 — Caractériser l'interface commune

Créer `packages/local-collectors/src/opencode-session-facts.test.ts` avant la
refactorisation. Sa première version caractérise les deux sorties publiques
existantes (`collectOpenCode` et `readOpenCodeSessionDetail`) à partir de la
même fixture ; après extraction, conserver les mêmes attentes à l'interface du
module commun. Figer :

- output = output source + reasoning ;
- cache read/write séparés ;
- modèle = `providerID/modelID` ;
- agrégation par modèle et ordre canonique ;
- coût reporté distinct de la valeur API calculée ;
- union d'intervalles chevauchants ;
- intervalle sans completion marqué partiel ;
- parent humain, interne et non résolu ;
- comptage outils/tours ;
- overflow/métrique invalide rejeté sans `NaN`.

**Verify** :

~~~sh
bun test packages/local-collectors/src/opencode-session-facts.test.ts
~~~

**Expected** : le test de caractérisation passe avant extraction. S'il expose
une divergence déjà consignée par A, garder le test et le correctif dans le
même lot, mais ne remettre aucun commit rouge. Toute divergence non prévue est
un STOP.

### Step 2.2 — Extraire le module profond

Créer `packages/local-collectors/src/opencode-session-facts.ts`, module interne
non exporté par `package.json`. Son interface doit se limiter à :

- decoder une row message inconnue vers un fait validé ;
- construire un résumé de projection partagé ;
- construire les groupes/phases nécessaires au détail.

Le module possède les règles de tokens, model identity, coût reporté, dates,
union d'intervalles et parent kind. Les SQL restent explicites dans :

- `collectors/opencode.ts` pour le scan toutes sessions ;
- `opencode-history.ts` pour une session bornée et les prompts.

Les deux adapters traduisent leurs rows SQL vers le même decoder. Ne créer ni
port abstrait ni classe : c'est une dépendance pure in-process.

**Verify** :

~~~sh
bun test \
  packages/local-collectors/src/opencode-session-facts.test.ts \
  packages/local-collectors/src/db-collectors.test.ts \
  packages/local-collectors/src/opencode-history.test.ts
~~~

**Expected** : toutes les attentes de rapport et détail passent.

### Step 2.3 — Retourner détail et projection depuis le même parse

Ajouter d'abord dans `packages/report-core/src/session-detail.ts`, avec tests :

- `SessionProjectionModelFacts`, `SessionProjectionFacts` et
  `LocalSessionAnalysis` ;
- `sessionProjectionFactsForSerializedRow`, qui valide la row inconnue avec les
  validateurs internes de report-core avant de produire les faits ;
- la règle legacy multi-modèle → `modelSegments: null`.

Ajouter `readCodexSessionAnalysis` et `readOpenCodeSessionAnalysis` retournant
`LocalSessionAnalysis | null`. Pour que le commit B reste vert avant la
migration serveur de C, conserver temporairement
`readCodexSessionDetail` / `readOpenCodeSessionDetail` comme wrappers immédiats
retournant seulement `analysis.detail`. Ces wrappers n'ont aucune logique et
seront supprimés à la Step 3.3 après migration du dernier appelant.

Pour Codex, `createCodexSessionParser(true)` doit produire `detail` et
`projection` après un seul `finish()`. Pour OpenCode, la projection vient du
nouveau module de faits, pas d'un recalcul dans le serveur.

Mettre à jour les tests de collectors pour vérifier :

~~~ts
expect(analysis.projection).toEqual(
  sessionProjectionFactsForSerializedRow(serializeUsageRow(reportRow)),
);
~~~

sur les cas Codex multi-modèle, overlap, open task, replay child et OpenCode
multi-modèle/parent partiel. La fonction pure
`sessionProjectionFactsForSerializedRow` appartient à report-core.

**Verify** :

~~~sh
bun test \
  packages/report-core/src/session-detail.test.ts \
  packages/local-collectors/src/codex-history.test.ts \
  packages/local-collectors/src/opencode-history.test.ts \
  packages/local-collectors/src/opencode-session-facts.test.ts
~~~

**Expected** : tous les tests passent ; les deux anciens exports ne contiennent
qu'une délégation temporaire vers la nouvelle API.

Si la projection sérialisée OpenCode change pour une source inchangée, incrémenter
`OPENCODE_DB_CACHE_VERSION` (actuellement 7 à `cb9bc22`) et ajouter un test de
cache miss. Si la refactorisation est strictement à parité, garder la version et
consigner la preuve dans le log.

### Step 2.4 — Éliminer les doubles propriétaires

Dans `collectors/opencode.ts` et `opencode-history.ts`, supprimer les helpers
locaux désormais possédés par `opencode-session-facts.ts`. Garder dans
`opencode-history.ts` uniquement les budgets, SQL bornés, prompt extraction et
projection UI.

**Verify** :

~~~sh
grep -nE "tokensFromRow|mergedActivityIntervals|activeDuration|modelLabel" \
  packages/local-collectors/src/collectors/opencode.ts \
  packages/local-collectors/src/opencode-history.ts
~~~

**Expected** : aucun helper sémantique dupliqué ; les éventuels matches sont des
appels/imports vers le module commun, pas des implémentations.

## Work package 3 — Lier l'analyse à une révision exacte

**Owner** : Agent C.

### Step 3.1 — Compléter puis remplacer le contrat public de requête

Dans `packages/report-core/src/session-detail.ts` :

- conserver les types/fonctions de projection livrés par B ;
- remplacer `{ harnessKey, machineId, sourceSessionId }` par
  `{ revision, rowId }` ;
- ajouter ancre, résultat d'ancre, consistency et réponse décrits plus haut ;
- ajouter parsers exact-key et budgets pour chaque objet ;
- ajouter `sessionDetailRequestFingerprint` avec préfixe versionné
  `session-detail-v2:` ;
- préserver et étendre `sessionProjectionFactsForSerializedRow` livré par B,
  puis ajouter `compareSessionProjectionFacts`, pure.

Tests obligatoires dans `session-detail.test.ts` :

1. request valide ;
2. rejet des anciens champs de provenance et de tout champ inconnu ;
3. row absente → `anchor: null`, mais row sans source → ancre non nulle avec
   provenance nullable ;
4. tokens/model segments exacts ;
5. multi-modèle legacy sans segments → attribution `null` ;
6. match complet ;
7. mismatch sur chaque champ avec ordre déterministe ;
8. deux usages indisponibles identiques → `cannot-compare` avec
   `checkedFields` exacts ;
9. disponibilité d'usage différente → divergence `coverage` ;
10. segments legacy absents → champ non vérifié, sans attribution inventée ;
11. coût différent sans autre changement → reste `matches-report` ;
12. réponse oversize/prompts invalides toujours rejetés.

**Verify** :

~~~sh
bun test packages/report-core/src/session-detail.test.ts
~~~

**Expected** : tous les cas passent, sans `any` ni assertion large.

### Step 3.2 — Ajouter le kind `session-detail-anchor` au runner

Modifier :

- `packages/report-data/src/session-query-sqlite.ts` ;
- `packages/report-data/src/revision-query-runner.ts` ;
- `apps/web/src/server/revision-query-runner.server.ts` ;
- `packages/report-data/src/session-query-runner.test.ts`.

Le SQL doit être explicite :

~~~sql
SELECT source_row_json
FROM session_rows
WHERE row_id = ?
ORDER BY ordinal
LIMIT 2
~~~

Comportement :

- zéro row → `anchor: null` ;
- une row → parser JSON strict, puis ancre non nulle ; si `source` ou l'un de
  ses identifiants manque, conserver le champ de provenance à `null` ;
- deux rows → `QueryFailed`, car `row_id` doit être unique ;
- résultat avec `revision` et fingerprint canonique ;
- même lease, permissions, subprocess, byte budget et cleanup que les autres
  kinds ;
- aucun import `bun:sqlite` dans un module client/Nitro.

Ne pas modifier le schéma SQLite : `source_row_json` existe déjà.

**Verify** :

~~~sh
bun test packages/report-data/src/session-query-runner.test.ts \
  apps/web/src/server/revision-query-runner.server.test.ts
~~~

Si le second fichier n'existe pas encore, créer ce test à côté du runner et
tester la nouvelle spec avec les patterns du runner existant.

**Expected** : anchor trouvé/absent/dupliqué, révision expirée, fingerprint
incorrect, JSON invalide et résultat borné sont tous couverts et passent.

### Step 3.3 — Orchestrer ancre puis lecture locale côté serveur

Refactorer `apps/web/src/server/session-detail.server.ts` autour d'une seule
fonction publique :

~~~ts
getLocalSessionDetailForServer(
  request: SessionDetailRequest,
  dependencies?: SessionDetailServerDependencies,
): Promise<SessionDetailResponse>
~~~

Les dépendances injectables de test sont :

- `resolveAnchor(request)` ;
- `readMachine()` ;
- `readAnalysis(harnessKey, sourceSessionId)`.

Ordre obligatoire :

1. parser la request ;
2. résoudre l'ancre sous la révision ;
3. mapper `RevisionExpired` sans relire une révision plus récente ;
4. mapper séparément row absente (`report-row-not-found`), provenance
   incomplète (`report-provenance-unavailable`) et harness non supporté ;
5. vérifier que `anchor.machineId` est la machine locale ;
6. lire `LocalSessionAnalysis` ;
7. comparer les projections ;
8. parser la réponse finale.

`apps/web/src/server/report-payload.ts` conserve
`validateTrustedLocalRequest`. Il utilise le nouveau validator, sans endpoint
compatibilité acceptant l'ancienne provenance.

Après migration du serveur, supprimer les deux wrappers temporaires
`readCodexSessionDetail` / `readOpenCodeSessionDetail` et mettre à jour leurs
tests restants pour utiliser l'analyse complète.

Tests serveur obligatoires :

- match ;
- divergence ;
- cannot compare ;
- revision expired ;
- row not found ;
- row trouvée sans source/provenance complète ;
- non-local ;
- unsupported ;
- historique absent ;
- exception de lecture transformée en `history-unavailable` ;
- `readAnalysis` n'est jamais appelé avant validation ancre/machine.

**Verify** :

~~~sh
bun test apps/web/src/server/session-detail.server.test.ts
~~~

**Expected** : toutes les branches passent et aucune provenance client n'atteint
`readAnalysis`. Puis :

~~~sh
grep -RIn "readCodexSessionDetail\|readOpenCodeSessionDetail" \
  packages apps --include='*.ts'
~~~

ne retourne aucun match.

### Step 3.4 — Simplifier le client

Dans `apps/web/src/session-detail-client.ts` :

- `loadSessionDetail` prend `{ revision, rowId }` ;
- `canAnalyzeSession` ne construit plus de request de provenance ;
- le parser strict reste appliqué à toute réponse serveur ;
- supprimer `sessionDetailRequestForRow`.

Tests :

- request exacte ;
- réponse malformed rejetée ;
- absence de révision empêche l'action côté présentation ;
- aucun path/machine/source id n'est sérialisé par le client.

**Verify** :

~~~sh
bun test apps/web/src/session-detail-client.test.ts
~~~

**Expected** : exit 0 et :

~~~sh
grep -RIn "sessionDetailRequestForRow" apps/web/src --include='*.ts' --include='*.tsx'
~~~

ne retourne aucun match.

## Work package 4 — Rendre portée, confidentialité et confiance explicites

**Owner** : Agent D.

### Step 4.1 — Introduire `SessionAnalysisTarget` au seam du drawer

Créer `apps/web/src/session-analysis-target.ts` et son test. Centraliser
l'adaptation depuis :

- un `SessionPageItem` servi, dont le `kind` est autoritaire ;
- une ligne de campagne in-memory avec son `CampaignView` ;
- une session atomique/enfant.

Le target de campagne porte `visibleCount` et `totalCount`. Une session enfant
reste `kind: 'session'` même si elle appartient à une campagne. Le
`reportRowId` d'un `campaign-root` est l'ID de la racine, tandis que
`summaryRow` conserve les totaux visibles utilisés par le drawer Summary.

Modifier `dashboard.tsx` et `session-drawer.tsx` pour passer le target complet.
Le drawer ne teste plus les propriétés optionnelles de campagne. Le Dashboard
stocke le `SessionAnalysisTarget` sélectionné (en plus de la clé nécessaire au
highlight), au lieu de le recalculer seulement depuis `rowId` :

- un clic sur une row top-level utilise le `SessionPageItem.kind` ou le
  `CampaignView` comme origine autoritaire ;
- un clic sur un enfant crée explicitement un target `session` ;
- Overview et la navigation previous/next créent explicitement un target
  `session`, même si la racine possède le même `rowId` qu'une campagne affichée.

Cette origine explicite est obligatoire : rechercher seulement le `rowId` dans
`SessionQueryState.items` reclassifierait à tort une racine atomique atteinte
par navigation comme campagne.

Tests obligatoires :

- session simple ;
- campagne 15/15 ;
- campagne filtrée 6/15 ;
- enfant chargé ;
- navigation vers la session voisine redevient `session` ;
- sélection Overview sans révision servie n'affiche pas Analyze.

**Verify** :

~~~sh
bun test apps/web/src/session-analysis-target.test.ts \
  apps/web/src/session-query-client.test.ts
~~~

**Expected** : tous les cas passent.

### Step 4.2 — Créer un modèle pur de présentation

Créer `apps/web/src/session-analysis-presentation.ts` et son test. Le modèle
retourne des éléments discriminés, par exemple :

~~~ts
type SessionAnalysisPresentationItem =
  | { kind: 'consistency-meta'; text: string; tone: 'neutral' }
  | { kind: 'consistency-warning'; text: string; tone: 'warning' }
  | { kind: 'scope'; text: string; tone: 'neutral' }
  | { kind: 'privacy'; text: string; tone: 'neutral' }
  | { kind: 'partial-duration'; text: string; tone: 'warning' }
  | { kind: 'partial-turns'; text: string; tone: 'warning' }
  | { kind: 'prompt-truncation'; text: string; tone: 'warning' };
~~~

Texte attendu :

- match : `Local detail · comparable metrics match this report revision.`,
  inline et neutre ;
- divergence : `Local trace differs from this report revision.`, warning ;
- cannot compare : `Local detail · comparison unavailable for this row.`,
  inline et neutre ;
- campagne complète : `Root rollout · 15 rollouts` ;
- campagne filtrée : `Root rollout · 6 visible of 15 rollouts` ;
- confidentialité près de Prompts :
  `Local only · detailed prompt bodies are not included in reports or exports.`

Le texte de divergence peut lister les noms humanisés des
`differingFields`. Il ne dit ni « newer » ni « stale ».

Tests de table complets :

- chaque consistency ;
- chaque scope ;
- partial duration/turns ;
- troncature ;
- combinaisons : match + partial, divergence + partial, campagne filtrée ;
- seuls les éléments `tone: 'warning'` deviennent des alerts/status.

**Verify** :

~~~sh
bun test apps/web/src/session-analysis-presentation.test.ts
~~~

**Expected** : toutes les combinaisons passent sans rendu DOM.

### Step 4.3 — Rendre le modèle, pas des conditions ad hoc

Refactorer `session-analysis.tsx` pour consommer le modèle :

- supprimer le grand encart permanent « Live local trace » ;
- afficher match/cannot-compare comme petite metadata d'en-tête ;
- afficher divergence avec `warningNotice` et `role="status"` ;
- afficher la portée comme badge/metadata, jamais warning ;
- déplacer la confidentialité dans le header de Prompts ;
- garder partial duration, partial turns et prompt truncation comme warnings ;
- garder `observedAt` en bas, car c'est une information utile ;
- ajouter des attributs stables
  `data-session-analysis-item="<kind>"` et `data-tone="neutral|warning"` pour
  l'E2E, sans utiliser les classes CSS comme API de test.

Créer `apps/web/src/session-analysis.render.test.tsx`. Utiliser le renderer SSR
déjà fourni par `solid-js/web` (`renderToString`) : ne pas ajouter Testing
Library, jsdom ou une nouvelle dépendance. Rendre `SessionAnalysis` avec une
fixture minimale valide pour chaque combinaison et vérifier le HTML produit :

- `matches-report` et `cannot-compare` ont `data-tone="neutral"` et aucun
  `role="status"` sur leur item ;
- `differs-from-report` a `data-tone="warning"`, `role="status"` et les champs
  divergents humanisés ;
- scope complet, scope 6/15 et confidentialité sont neutres ;
- durée partielle, tours partiels et prompt tronqué sont chacun warning avec
  `role="status"` ;
- un cas combiné divergence + durée partielle contient exactement deux items
  warning ;
- aucun rendu ne contient « may be newer » ou « source newer ».

Les tests purs de `session-analysis-presentation.test.ts` prouvent la table de
décision ; ce test de rendu prouve que le composant ne perd pas `tone`, `kind`
ou le rôle accessible en la matérialisant.

Si les styles existants suffisent, ne pas toucher le design-system. Si un style
est indispensable, STOP et demander l'élargissement de scope plutôt que
d'ajouter une classe locale ad hoc.

**Verify** :

~~~sh
bun test apps/web/src/session-analysis.test.ts \
  apps/web/src/session-analysis.render.test.tsx \
  apps/web/src/session-analysis-presentation.test.ts \
  apps/web/src/session-analysis-target.test.ts
~~~

**Expected** : exit 0 ; tous les tons et rôles sont prouvés dans le markup du
composant, pas seulement dans le modèle pur.

### Step 4.4 — Corriger définitivement le nombre de campagne

Toute phrase qui décrit les métriques agrégées utilise `visibleCount`. Le
`totalCount` sert uniquement au dénominateur/total réel. Ajouter le cas 6/15 au
test du target et au test de présentation.

**Verify** :

~~~sh
grep -RIn "campaign summary combines.*campaignTotalCount\|may be newer" \
  apps/web/src --include='*.ts' --include='*.tsx'
~~~

**Expected** : aucun match.

## Work package 5 — Fermer la boucle parité, E2E et documentation

**Owner** : Agent E / coordinateur.

### Step 5.1 — Ajouter le scénario publish → mutate → compare

Dans
`packages/report-data/src/session-report-pipeline.integration.test.ts` :

1. collecter le Codex root et capturer sa `SessionProjectionFacts` ;
2. appeler `readCodexSessionAnalysis` et obtenir `matches-report` ;
3. appeler `appendCodexRootUsage` sans republier ;
4. relire l'analyse et obtenir `differs-from-report` avec exactement les champs
   modifiés ;
5. réexécuter `codex.sessions`, recréer le payload/l'ancre ;
6. obtenir à nouveau `matches-report`.

Ce test vérifie la sémantique de fraîcheur avec de vrais fichiers. Le test du
runner vérifie séparément la lease/révision ; ne démarrer aucun serveur dans ce
test.

**Verify** :

~~~sh
bun test packages/report-data/src/session-report-pipeline.integration.test.ts
~~~

**Expected** : séquence `match → differs → match` déterministe.

### Step 5.2 — Étendre un seul smoke Playwright production

Refactorer `apps/web/e2e/production-server.ts` pour utiliser
`seedHarnessHome(temporaryHome, { codexSessionCount: 205, harnesses: ['codex'] })`
au lieu de dupliquer la génération JSONL. Préserver exactement 205 sessions et
le port 4175.

Dans `production-report.spec.ts`, après la pagination existante :

1. importer `HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL`, faire un
   `page.request.get('/?tab=sessions')` avant navigation/hydratation et vérifier
   que le HTML de document ne contient pas ce sentinel ;
2. ouvrir la session root connue ;
3. cliquer `Analyze` ;
4. attendre `Session analysis` puis vérifier que le sentinel est maintenant
   présent uniquement dans la section Prompts chargée à la demande ;
5. vérifier une metadata
   `data-session-analysis-item="consistency-meta"` ;
6. vérifier qu'aucun élément neutre n'a `data-tone="warning"` ;
7. vérifier l'absence de « may be newer » ;
8. vérifier que la confidentialité est visible près de Prompts sans
   `role="status"` ;
9. fermer le drawer et conserver les assertions exact-revision existantes.

Ne pas ajouter quatre specs navigateur par harness. Les fixtures multi-harness
sont déjà couvertes au lot 1.

**Verify** :

~~~sh
bun run test:e2e-production
~~~

**Expected** : suite production complète verte, 205 sessions toujours paginées,
sentinel absent du HTML initial puis visible seulement après la demande de
détail local.

### Step 5.3 — Documenter le contrat réel

Mettre à jour :

- `docs/session-analysis-sources.md` :
  - détail local indépendant ;
  - ancre résolue depuis la révision ;
  - sens exact des trois consistencies ;
  - divergence ≠ preuve que la source est plus récente ;
  - prompts toujours local-only ;
- `docs/architecture.md` :
  - ajouter `session-detail-anchor` aux queries exact-revision ;
  - documenter que le serveur, pas le navigateur, résout la provenance ;
  - documenter le module de faits OpenCode partagé ;
- `docs/public-package-interfaces.md` :
  - étendre `./session-detail` avec ancre/projection/consistency ;
  - marquer `./test-fixtures/harness-home` comme export test-only.

Ne pas recopier une matrice entière dans plusieurs docs. La source de vérité
harness reste `session-analysis-sources.md`.

**Verify** :

~~~sh
grep -RIn "may be newer" apps/web/src docs/session-analysis-sources.md
~~~

**Expected** : aucun match.

### Step 5.4 — Exécuter les gates finaux

Dans cet ordre :

~~~sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:web-production
bun run test:e2e
bun run test:e2e-production
git diff --check cb9bc22...HEAD
git status --short
~~~

**Expected** :

- chaque commande sort 0 ;
- `bun.lock` est inchangé ;
- `git diff --check` ne produit rien ;
- seuls les fichiers de scope et le log/index sont modifiés.

Mettre alors le log à jour, puis passer la row 025 de `plans/README.md` à
`DONE`. Ne pas modifier les plans 001-024.

## Test plan consolidé

### Unitaires purs

- parsers stricts request/anchor/response ;
- projection de row et comparaison ;
- faits OpenCode ;
- target session/campaign ;
- modèle de notices.

### Intégration locale

- vraies bases OpenCode et Cursor ;
- vrais JSONL Claude et Codex ;
- collecte → usage-store → payload → Session SQLite ;
- parité projection pure/SQLite ;
- parité report facts/local analysis ;
- `match → differs → match` après mutation/recollecte.

### Serveur

- exact revision anchor et fingerprint ;
- expiry/row absente/duplicate ;
- provenance serveur et machine locale ;
- aucun read local sur ancre invalide ;
- réponses bornées et strictement parsées.

### Navigateur

- un smoke production Codex ;
- un test SSR du composant pour chaque tone/rôle et combinaison critique ;
- metadata neutre pour match/confidentialité/scope ;
- warning seulement pour divergence/partial/truncation ;
- aucune régression pagination/révision ;
- sentinel de prompt absent du HTML initial et présent après lecture locale à
  la demande.

## Done criteria

Tous les critères doivent être vrais :

- [ ] Le client n'envoie que `revision` et `rowId`.
- [ ] La provenance locale est résolue depuis `source_row_json` sous lease de
      la révision demandée.
- [ ] Row absente et row sans provenance ont deux résultats typés distincts ;
      aucune des deux ne déclenche une lecture locale.
- [ ] Une révision expirée ne tombe jamais silencieusement sur la dernière
      révision.
- [ ] Les readers Codex/OpenCode retournent détail et projection issus du même
      parse.
- [ ] Les règles sémantiques OpenCode n'ont qu'un propriétaire.
- [ ] `matches-report`, `differs-from-report` et `cannot-compare` sont parsés,
      bornés et testés.
- [ ] La matrice exacte de `checkedFields` est testée, notamment usage
      indisponible des deux côtés et disponibilité asymétrique.
- [ ] Le coût n'entre pas dans le comparateur de fraîcheur mais reste couvert
      par le golden.
- [ ] La campagne filtrée affiche `visibleCount / totalCount` correctement.
- [ ] Portée et confidentialité ne sont jamais rendues avec le tone warning.
- [ ] « may be newer » et l'ancienne request de provenance n'existent plus.
- [ ] Les vrais schémas OpenCode/Cursor sont exécutés dans la suite.
- [ ] Le golden traverse source → store → payload → SQLite final.
- [ ] Le test réel obtient `match → differs → match`.
- [ ] Le smoke production ouvre Session Analysis.
- [ ] Le test de rendu prouve les rôles et tons de divergence, scope, privacy,
      partial et truncation.
- [ ] Aucun prompt détaillé n'est présent dans une révision/export/HTML initial,
      et le sentinel n'apparaît qu'après la lecture locale demandée.
- [ ] `bun run check`, lint, typecheck, tests, build et les deux E2E passent.
- [ ] Le log contient les cinq commits et les résultats.
- [ ] La row 025 est `DONE` dans `plans/README.md`.

## STOP conditions

STOP et rapporter, sans improviser, si :

- les fichiers de scope ont dérivé matériellement depuis `cb9bc22` ;
- la correction exige de mettre prompts, paths ou timeline complète dans une
  révision ;
- le browser doit encore fournir machine/harness/source session pour que
  l'endpoint fonctionne ;
- le nouveau lookup contourne le runner exact-revision, sa lease ou ses budgets ;
- `row_id` n'est pas unique dans un artefact valide ;
- une parité ne peut être obtenue qu'en ignorant une divergence de tokens,
  durée, modèles, tours ou outils ;
- l'unification OpenCode rend le SQL dynamique/opaque ou supprime ses limites ;
- un test golden calcule ses attentes avec le code de production testé ;
- une valeur de coût exige une nouvelle politique de pricing plutôt qu'une
  correction de parsing ;
- le travail nécessite une refonte globale de la table ou du design-system ;
- un gate échoue deux fois après une correction raisonnable ;
- un agent doit toucher un fichier possédé par un autre lot non intégré.

## Maintenance notes

- Tout nouveau harness supportant Session Analysis doit produire
  `LocalSessionAnalysis`, définir ses `SessionProjectionFacts` et ajouter un cas
  au golden avant d'apparaître dans `sessionDetailHarnessKeys`.
- Toute modification des faits sérialisés d'un parser avec cache doit
  incrémenter sa version de cache.
- Ajouter un champ au rapport ne signifie pas automatiquement l'ajouter au
  comparateur. Seuls les champs dérivés avec la même sémantique des deux côtés
  sont comparables.
- Le reviewer doit particulièrement vérifier : absence de provenance client,
  absence de données privées dans l'ancre, parité OpenCode, statut de campagne
  filtrée, et absence de causalité inventée dans le wording.
- La refonte complète de `SessionPresentationRow` en union reste un follow-up
  possible si d'autres consommateurs mélangent encore identité racine et
  métriques agrégées. Ce plan sécurise le seam critique sans élargir cette
  migration.
