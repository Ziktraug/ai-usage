# Plan 026: Unifier le drawer de session et rendre la chronologie lisible

> **Instructions au coordinateur** : ce fichier est un plan maître composé de
> quatre lots livrables. Chaque agent doit lire le plan entier, puis
> n'implémenter que le lot qui lui est attribué. Le coordinateur est le seul à
> modifier le statut dans `plans/README.md`. Chaque agent exécute toutes les
> vérifications de son lot et remet son commit, ses résultats et tout écart
> constaté ; il ne pousse pas et n'ouvre pas de PR sans demande explicite.
>
> **Contrôle de dérive à exécuter en premier** :
>
> `git diff --stat b24f6a2..HEAD -- apps/web/src/session-analysis-model.ts apps/web/src/session-analysis.tsx apps/web/src/session-analysis-presentation.ts apps/web/src/session-analysis.test.ts apps/web/src/session-analysis.render.test.tsx apps/web/src/session-drawer.tsx apps/web/e2e/production-report.spec.ts docs/session-analysis-sources.md`
>
> Si un fichier de portée a changé depuis `b24f6a2`, comparer les extraits de
> « Current state » au code vivant. Si le contrat `SessionDetail`, les items de
> présentation ou les sélecteurs E2E ont changé, STOP : mettre à jour ce plan
> avant de coder.

## Status

- **Status**: TODO
- **Priority**: P1
- **Effort**: M, à livrer en quatre lots séquentiels
- **Risk**: MEDIUM — plan purement UI, mais il réécrit un composant couvert par
  un smoke E2E production et treize tests de rendu SSR
- **Depends on**: plan 025 DONE (contrat `SessionDetailResponse`, consistency,
  items de présentation et sélecteurs `data-session-analysis-item`)
- **Category**: UX, tests, docs
- **Planned at**: commit `b24f6a2`, 2026-07-20
- **Suggested integration branch**: créer `feat/026-unified-session-drawer`
  depuis `b24f6a2` (ou la tête de `agent/improve-session-analysis`) ; ne pas
  pousser sans instruction

## Why this matters

Retour utilisateur du 2026-07-20 sur la vue « Analyze root » :

1. **Deux vues pour une même session.** Le bouton « Analyze » remplace tout le
   corps du drawer et en change la largeur. Le résumé (titre, anatomie tokens,
   coût, ratios médians) disparaît au moment où l'on en a le plus besoin ;
   l'analyse s'ouvre sur un UUID et quatre tuiles de durées jargonneuses. C'est
   pour cela que le résumé « se lit étrangement mieux » que l'analyse.
2. **La même dimension est répétée trois fois.** « Model and effort phases »,
   « Task timeline » et « Prompts » sont trois listes chronologiques sur le
   même axe wall-clock. En mono-modèle (cas ultra-majoritaire), la section
   phases est une barre pleine largeur qui n'apporte rien ; la liste Prompts
   ré-énumère quasi 1:1 les mêmes événements que la timeline (chaque turn
   affiche « 1 prompts »).
3. **Le temps est la seule dimension encodée.** Une tâche de 42 m / 2,5 M
   tokens paraît moitié d'une tâche de 1 h 40 / 46,3 M tokens. Les tokens — le
   cœur de la thèse produit — sont relégués en méta-texte 10 px.
4. **L'axe wall-clock écrase tout.** Sur une session de 18 h dont 12 h entre
   tâches, les barres deviennent illisibles ; le `minW: 4px` rend une tâche de
   2 s visible mais mensongère.

Le plan fusionne les deux vues en une seule vue progressive, fusionne
turns + prompts en une timeline unique avec une colonne tokens alignée, rend la
section phases conditionnelle, et introduit une échelle à gaps compressés
honnête (ruptures marquées, bascule wall-clock disponible).

## Décisions UX normatives

Structure cible du drawer (une seule vue, un seul scroll) :

~~~text
[drawerTop : badge harness · compteur · ↑ ↓ · Analyze/Hide · ✕]
[Titre : sessionLabel · provider/modèle]
[SegmentBar anatomie tokens + légende]
[≈ n× median cost · n× median duration]
[bloc campagne éventuel]
[grille de détails (Started, Tokens, API value, …)]
[actions Filter project / Filter model]
──────────── section chronologie (chargée à la demande) ────────────
[Session analysis  ·  dates → · session id]
[consistency-meta / scope / consistency-warning]
[Timeline unifiée]
   caption : Task-open time ≥ 6h 08m · Session span 18h 14m ·
             Between tasks ≤ 12h 06m · Task blocks 10
   axe     : 14:10 ──⫽ 5h 12m──────⫽ 3h 40m── 08:24   [Show real gaps]
   ligne   = 1 tâche : label = préview du prompt (expandable),
             piste temps (couleur = phase), mini-barre tokens à droite
[phases : bande dédiée seulement si ≥ 2 phases, sinon une ligne de légende]
[Detail observed … from local history.]
~~~

Décisions fermes :

1. Le résumé reste toujours visible ; l'analyse est une section additionnelle
   du même scroll, jamais un remplacement. La largeur élargie (960 px) est
   conservée quand la chronologie est ouverte.
2. Le chargement de la chronologie reste déclenché par une action explicite de
   l'utilisateur (« Analyze » / « Analyze root »). Aucun prompt local n'est lu
   à la simple ouverture du drawer : l'invariant E2E « sentinel absent avant la
   demande » du plan 025 reste vrai.
3. Turns et prompts fusionnent : une ligne de timeline par tâche, le prompt
   comme label. Un prompt appartient à la première tâche qui référence son id
   dans `promptIds` ; un prompt orphelin devient une ligne à marqueur ponctuel ;
   une tâche sans prompt garde le label `Task N`.
4. Les quatre tuiles de durées disparaissent au profit d'une ligne de caption
   au-dessus de la timeline, avec les mêmes bornes ≥ / ≤ et le même texte
   sr-only « At least / At most ».
5. La bande « Model and effort phases » ne se rend que si la session compte au
   moins deux phases distinctes. En mono-phase, une ligne de légende la
   remplace : `gpt-5.6-sol · ultra · 100% tokens · ≈ $115.38`. En multi-phase,
   les barres de tâches prennent la couleur de leur phase.
6. Une colonne tokens alignée (mini-barre normalisée sur la tâche max + valeur
   compacte) est ajoutée à droite de la piste temporelle, à partir du
   breakpoint `md`. En dessous, la valeur reste dans la ligne méta actuelle.
7. L'échelle par défaut compresse les gaps inter-blocs supérieurs à 15 minutes
   en segments fixes marqués d'une rupture (durée du gap au title). Un bouton
   à `aria-pressed` bascule vers l'échelle wall-clock. Si aucun gap n'est
   compressible, les deux échelles sont identiques et le bouton est masqué.
8. Vocabulaire : les lignes s'appellent `Task N` pour Codex, `Turn N` pour
   OpenCode et le fallback générique, via un nouveau champ `rowNoun` de
   `SessionDurationSemantics`. Le mot « Turn » de la table (turns API) ne
   désigne plus jamais une tâche Codex.
9. Corrections de détail obligatoires : pluriel (`1 prompt` / `2 prompts`,
   idem tools), coût de phase à 2 décimales dès `>= $1` (4 en dessous de $1),
   modèle/effort répété sur chaque ligne seulement quand il diffère de la
   phase dominante de la session.

## Invariants non négociables

1. Aucun changement de protocole : `loadSessionDetail({ revision, rowId })`,
   `SessionDetailResponse`, le serveur et le runner exact-revision du plan 025
   sont hors de portée. Ce plan ne touche que le rendu et des fonctions pures
   côté client.
2. Les prompts détaillés restent chargés à la demande et locaux. Le sentinel
   `HARNESS_FIXTURE_PRIVATE_PROMPT_SENTINEL` ne doit jamais apparaître dans le
   HTML initial du document.
3. Le contrat de test `data-session-analysis-item="<kind>"` +
   `data-tone="neutral|warning"` est conservé pour tous les items de
   `buildSessionAnalysisPresentation`. Seuls les items `tone: 'warning'`
   portent `role="status"`. Pas de drapeau global de qualité.
4. Les sémantiques de durée par harness (`session-analysis-model.ts`) restent
   la seule source du vocabulaire ; pas de chaînes harness-spécifiques en dur
   dans le JSX.
5. La compression de gaps est un changement d'échelle d'affichage, jamais de
   données : les durées affichées (labels, captions, aria) restent les durées
   réelles, et chaque rupture est visuellement marquée.
6. Accessibilité : chaque piste garde `role="img"` avec un label complet
   (prompt, durée, tokens, outils, bornes) ; les disclosures restent des
   `<details>/<summary>` natifs ; la bascule d'échelle est un `<button>` avec
   `aria-pressed` ; la hiérarchie de headings reste valide dans le drawer.
7. Ne pas toucher `@ai-usage/design-system` si les styles locaux `css()` et
   les styles `report` existants suffisent. Si un style partagé devient
   indispensable, STOP et demander l'élargissement de scope.
8. `bun x ultracite check` doit rester vert ; pas de ternaires imbriqués, pas
   de dépassement de complexité cognitive dans `session-analysis.tsx` (extraire
   des sous-composants plutôt que d'empiler les conditions).

## Current state

Références prises à `b24f6a2`.

### Le drawer bascule entre deux vues exclusives

- `apps/web/src/session-drawer.tsx:56` : `analysisDrawer` élargit le drawer à
  960 px quand l'analyse est ouverte.
- `apps/web/src/session-drawer.tsx:146-157` : `toggleAnalysis` vide l'état et
  bascule `analysisOpen`.
- `apps/web/src/session-drawer.tsx:159-171` : labels « Analyze » /
  « Analyze root » / « Summary » et aria-labels
  « Analyze [root] session chronology » / « Back to session summary ».
- `apps/web/src/session-drawer.tsx:284-296` : deux `<Show>` mutuellement
  exclusifs rendent soit `SessionAnalysis`, soit le résumé complet
  (lignes 296-436 : titre, `SegmentBar`, ratios médians, bloc campagne,
  `drawerGrid`, actions de filtre).

### L'analyse répète trois fois l'axe temporel

- `apps/web/src/session-analysis.tsx:439-464` : quatre tuiles métriques
  (active/elapsed/idle/bursts) avec bornes ≥ / ≤ via `MetricValue`
  (lignes 381-389).
- Lignes 496-514 : section « Model and effort phases », rendue même avec une
  seule phase.
- Lignes 516-536 : section timeline des turns ; `TurnRow` (336-377) affiche
  `Turn {index+1}` et une méta `model · effort · tokens · tools · N prompts`
  avec le bug de pluriel ligne 360-361.
- Lignes 538-585 : section « Prompts (n) » : disclosures `<details>` avec
  préview 120 caractères (`promptPreviewText`, 278-283) et corps mono.
- Ligne 168 : `timelineBar` a `minW: '4px'`.
- Lignes 54-59 : `moneyFormatter` autorise 4 décimales quel que soit le
  montant (`≈ $115.3777`).
- Lignes 273-277 : `phaseTone` attribue les couleurs `chart.c1..c6` par clé de
  phase ; `turnBar` (ligne 171) ignore les phases et colore tout en `accent`.

### Le modèle pur existant

- `apps/web/src/session-analysis-model.ts:23-71` : trois
  `SessionDurationSemantics` (codex/opencode/générique), sans nom de ligne.
- Lignes 115-134 : `positionOnTimeline` projette un intervalle sur un axe
  linéaire unique.
- Lignes 141-162 : `countActivityBursts` fusionne déjà les intervalles en
  blocs — la même logique de fusion sert de base aux segments d'échelle.
- `packages/report-core/src/session-detail.ts:118-148` : `SessionDetailTurn`
  porte `promptIds`, `intervals`, `tokens`, `tools`, `model`, `effort` ;
  `SessionDetail.prompts` porte des `SessionDetailPrompt { id, text,
  timestamp, truncated }`. La jointure turn↔prompt est donc purement locale.

### Les items de présentation et leurs consommateurs de test

- `apps/web/src/session-analysis-presentation.ts:8-15` : sept kinds discriminés
  (`consistency-meta`, `consistency-warning`, `scope`, `privacy`,
  `partial-duration`, `partial-turns`, `prompt-truncation`).
- `apps/web/src/session-analysis.render.test.tsx` : treize tests SSR via
  `renderToString` + `viteServer.ssrLoadModule` (lignes 34-49) ; fixtures
  `SessionDetail` minimales construites à la main.
- `apps/web/e2e/production-report.spec.ts:270-296` : le smoke production
  clique « Analyze root session chronology », vérifie le sentinel dans
  `section[aria-labelledby="session-prompts"]`, les items consistency/privacy,
  puis `getByText('Root task-open time').locator('..')` contient `≥` et
  `Between tasks` contient `≤`.
- `apps/web/src/shared.tsx:31-35,199` : `fmtNum`, `fmtMoney` (2 décimales),
  `fmtCompact`, `SegmentBar` sont réutilisables tels quels.

## Architecture cible

### Nouveaux contrats purs (`apps/web/src/session-analysis-model.ts`)

Les noms et discriminants sont prescriptifs ; les détails privés peuvent
varier.

~~~ts
export interface SessionDurationSemantics {
  // champs existants inchangés, plus :
  rowNoun: string; // 'Task' (codex) | 'Turn' (opencode, générique)
}

export interface SessionTimelinePromptRef {
  id: string;
  text: string;
  timestamp: string;
  truncated: boolean;
}

export type SessionTimelineRow =
  | {
      durationMs: number;
      effort: string | null;
      effortKind: SessionDetailEffortKind;
      index: number;
      intervals: SessionDetailInterval[];
      kind: 'task';
      model: string;
      prompts: SessionTimelinePromptRef[];
      tokenShareOfMax: number; // dans [0, 1] ; 0 si la tâche max a 0 token
      tokens: SessionDetailTokenCounts;
      tools: number;
    }
  | { kind: 'orphan-prompt'; prompt: SessionTimelinePromptRef };

export const buildSessionTimelineRows = (detail: SessionDetail): SessionTimelineRow[];

export type TimelineScaleMode = 'compressed' | 'wall-clock';

export interface TimelineScaleBreak {
  atPercent: number;
  gapMs: number;
}

export interface TimelineScale {
  breaks: TimelineScaleBreak[];
  mode: TimelineScaleMode;
  // représentation interne libre (segments triés), mais elle doit permettre
  // positionOnScale et rester sérialisable pour les tests
}

export const GAP_COMPRESSION_THRESHOLD_MS = 15 * 60 * 1000;

export const buildTimelineScale = (detail: SessionDetail, mode: TimelineScaleMode): TimelineScale;
export const positionOnScale = (scale: TimelineScale, startAt: string, endAt: string): TimelinePosition;
export const timelineHasCompressibleGaps = (detail: SessionDetail): boolean;

export interface SessionDurationCaptionPart {
  bound: 'lower' | 'upper' | null;
  key: 'active' | 'blocks' | 'gap' | 'span';
  label: string;
  value: string;
}

export const sessionDurationCaption = (
  detail: SessionDetail,
  semantics: SessionDurationSemantics,
  burstCount: number,
): SessionDurationCaptionPart[];

export const countLabel = (count: number, noun: string): string; // '1 prompt', '3 prompts'
~~~

Règles normatives :

- `buildSessionTimelineRows` trie les lignes chronologiquement
  (`startAt` de la tâche, `timestamp` du prompt orphelin ; ex æquo départagés
  par `index`). Chaque prompt apparaît exactement une fois : rattaché à la
  première tâche (ordre chronologique) dont `promptIds` contient son id, sinon
  ligne `orphan-prompt`. Un `promptId` sans prompt correspondant est ignoré
  sans erreur.
- `tokenShareOfMax = tokens.total / max(tokens.total des tâches)` ; `0` si le
  max est `0`. Jamais de `NaN`.
- `buildTimelineScale('wall-clock', …)` est l'identité actuelle :
  `positionOnScale` doit donner exactement les mêmes résultats que
  `positionOnTimeline` sur la même entrée.
- `buildTimelineScale('compressed', …)` : fusionner les intervalles de toutes
  les tâches en blocs (même règle que `countActivityBursts`) ; tout gap entre
  blocs strictement supérieur à `GAP_COMPRESSION_THRESHOLD_MS` devient un
  segment de largeur fixe de 2 % avec une entrée dans `breaks` ; les blocs et
  petits gaps se partagent la largeur restante proportionnellement à leur
  durée réelle. Sans gap compressible, résultat identique au mode wall-clock.
  Les positions restent clampées dans `[0, 100]` et monotones : pour deux
  instants `a <= b`, `left(a) <= left(b)`.
- `sessionDurationCaption` retourne exactement quatre parts dans l'ordre
  `active`, `span`, `gap`, `blocks`, avec `bound: 'lower'` sur `active` et
  `'upper'` sur `gap` quand `durationStatus === 'partial'`, `null` sinon ;
  labels et hints proviennent des champs existants de la sémantique.

### Composant (`apps/web/src/session-analysis.tsx`)

- `AvailableSessionAnalysis` rend, dans l'ordre : header (dates, session id,
  items `consistency-meta` / `scope` / `consistency-warning`), la timeline
  unifiée, la légende ou bande de phases, les items `privacy` /
  `prompt-truncation` / `partial-*` aux emplacements actuels, la ligne
  `Detail observed …`.
- La timeline unifiée vit dans la section existante
  `aria-labelledby="session-timeline"` (nouvel id : remplace à la fois
  `session-turn-timeline` et `session-prompts`). Son header contient le
  heading `timelineHeading`, la caption de durées (chaque part rendue avec
  `data-session-analysis-metric="active|span|gap|blocks"`), la description,
  l'item `privacy` et la bascule d'échelle.
- Chaque ligne `task` : colonne label = `<details>` dont le `<summary>` montre
  la préview du prompt principal (ou `${rowNoun} ${index + 1}` sans prompt) et
  une méta `durée · tokens · tools · prompts` ; le corps montre chaque prompt
  complet (timestamp, pill Truncated). Colonne piste = intervalles positionnés
  par `positionOnScale`, colorés par la phase couvrant le début de la tâche
  quand il y a ≥ 2 phases. Colonne tokens = barre `width:
  ${tokenShareOfMax * 100}%` + `fmtTokens(tokens.total)`.
- Chaque ligne `orphan-prompt` : même disclosure, marqueur ponctuel (losange)
  sur la piste, colonne tokens vide (`—`).
- Les ruptures d'échelle se rendent dans la ligne d'axe : un marqueur `⫽` par
  entrée de `breaks`, `title` = `formatSessionDuration(gapMs)` ; l'axe
  n'affiche plus la grille 25/50/75 % en mode compressé.
- Le formatteur de coût de phase passe à : `>= 1` → 2 décimales, `< 1` →
  4 décimales (helper local pur, testé via le rendu).

### Drawer (`apps/web/src/session-drawer.tsx`)

- Supprimer l'exclusion mutuelle : le corps du drawer rend toujours le résumé,
  puis, si `analysisOpen()`, le panneau `SessionAnalysis` en dessous (même
  `SESSION_ANALYSIS_PANEL_ID`, `aria-controls`/`aria-expanded` conservés).
- Labels : bouton fermé → « Analyze » / « Analyze root » (aria inchangés) ;
  ouvert → « Hide analysis » (aria « Hide session chronology »).
- `analysisDrawer` (960 px) continue de s'appliquer quand la section est
  ouverte. La navigation ↑/↓ referme la section (comportement actuel du
  `createEffect` conservé).

## Alternatives explicitement rejetées

- **Onglets Summary / Analysis dans le drawer** : rejeté. C'est le même mode
  switch avec un autre habillage ; le contexte (coût, anatomie) disparaît
  toujours pendant la lecture de la chronologie.
- **Charger l'analyse dès l'ouverture du drawer** : rejeté. Cela lirait les
  prompts locaux à chaque simple consultation et casserait l'invariant E2E
  « sentinel seulement après demande » du plan 025.
- **Encoder les tokens dans la hauteur ou l'opacité des barres temporelles** :
  rejeté. Deux grandeurs sur un même mark se lisent mal et la comparaison
  entre lignes devient impossible ; la colonne alignée garde deux encodages
  séparés et comparables.
- **Basculer la timeline entre dimension temps et dimension tokens** (pattern
  du navigateur de rapport) : rejeté ici. Avec ~10 lignes, les deux dimensions
  tiennent côte à côte sans bascule.
- **Échelle log ou axe temps actif pur** : rejeté. Une échelle segmentée avec
  ruptures marquées reste lisible ET honnête ; une échelle log est illisible
  pour des non-spécialistes, un axe « temps actif » sans marquage mentirait.
- **Bibliothèque de Gantt/dataviz externe** : rejeté. Le rendu actuel en divs
  positionnées suffit ; une dépendance ajouterait du poids et un risque a11y.
- **Supprimer la section phases** : rejeté. En multi-phase (sessions Codex
  après switch de modèle, OpenCode multi-provider), la bande reste le seul
  endroit qui montre coût et part de tokens par phase.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install check | `bun install --frozen-lockfile` | exit 0, lockfile inchangé |
| Modèle | `bun test apps/web/src/session-analysis.test.ts` | tests verts |
| Présentation | `bun test apps/web/src/session-analysis-presentation.test.ts` | tests verts |
| Rendu SSR | `bun test apps/web/src/session-analysis.render.test.tsx` | tests verts |
| Format/check | `bun run check` | exit 0 |
| Boundaries | `bun run lint` | exit 0 |
| Types | `bun run typecheck` | exit 0 |
| Tests | `bun run test` | exit 0 |
| Build | `bun run build` | exit 0 |
| Dev browser | `bun run test:e2e` | tests verts |
| Production browser | `bun run test:e2e-production` | tests verts |
| Whitespace | `git diff --check b24f6a2...HEAD` | aucune sortie |

Le dépôt utilise Ultracite : corrections ciblées pendant chaque lot ; le
coordinateur exécute `bun x ultracite fix` seulement après contrôle du
worktree.

## Scope

### In scope

- `apps/web/src/session-analysis-model.ts` et
  `apps/web/src/session-analysis.test.ts` ;
- `apps/web/src/session-analysis.tsx` et
  `apps/web/src/session-analysis.render.test.tsx` ;
- `apps/web/src/session-drawer.tsx` ;
- `apps/web/e2e/production-report.spec.ts` (mise à jour des sélecteurs du
  smoke existant, pas de nouveau spec) ;
- `docs/session-analysis-sources.md` (description UI de la vue unifiée) ;
- `plans/026-unify-session-drawer-chronology-log.md` et `plans/README.md`.

### Out of scope

- tout changement serveur, runner, collector, `report-core` ou protocole
  (`SessionDetail`, consistency, anchor : figés par le plan 025) ;
- `session-analysis-presentation.ts` : les kinds, textes et tones restent
  identiques (seul leur emplacement de rendu bouge) ;
- `session-analysis-target.ts`, `session-detail-client.ts`,
  `dashboard.tsx` (hors passage de props strictement nécessaire) ;
- le tableau des sessions, la navigation j/k, le bloc campagne du résumé ;
- `@ai-usage/design-system` (styles locaux `css()` uniquement) ;
- persistance de la préférence d'échelle (état éphémère du composant) ;
- support Claude/Cursor dans le détail (toujours `codex`/`opencode` seuls).

## Répartition entre agents et ordre d'intégration

| Agent | Lot | Ownership exclusif | Dépend de | Peut être parallèle |
| --- | --- | --- | --- | --- |
| A | Modèle pur de timeline unifiée | `session-analysis-model.ts` + son test | baseline | non, livre d'abord |
| B | Refonte du composant SessionAnalysis | `session-analysis.tsx` + render test | A | non |
| C | Drawer vue unique + E2E | `session-drawer.tsx` + `production-report.spec.ts` | B | non |
| D | Docs, gates et clôture | docs + log/index + gates | A-C | non |

Commits suggérés, style impératif du dépôt :

- `Add unified session timeline model`
- `Render one session chronology with tokens`
- `Fold session analysis into a single drawer view`
- `Document the unified session drawer`

Chaque agent remet : SHA, fichiers modifiés, commandes exactes, résultats,
écarts/STOP rencontrés. Préserver le changement utilisateur non lié courant
(`apps/cli/src/main.integration.test.ts` modifié au moment de la
planification).

## Work package 0 — Baseline et journal d'exécution

**Owner** : coordinateur.

### Step 0.1 — Vérifier le worktree et créer le journal

~~~sh
git status --short --branch
git rev-parse --short HEAD
~~~

Créer `plans/026-unify-session-drawer-chronology-log.md` avec SHA de départ,
table A-D (`TODO / IN PROGRESS / DONE / BLOCKED`), et une entrée par lot
(commit, commandes, résultats).

### Step 0.2 — Geler la baseline

~~~sh
bun test apps/web/src/session-analysis.test.ts \
  apps/web/src/session-analysis-presentation.test.ts \
  apps/web/src/session-analysis.render.test.tsx
bun run typecheck
~~~

**Expected** : exit 0. Si la baseline échoue, consigner et STOP ; ne pas
l'attribuer au plan.

## Work package 1 — Modèle pur de timeline unifiée

**Owner** : Agent A. Fichiers : `apps/web/src/session-analysis-model.ts`,
`apps/web/src/session-analysis.test.ts`.

### Step 1.1 — `rowNoun`, `countLabel` et caption de durées

- Ajouter `rowNoun` aux trois sémantiques : `'Task'` (codex), `'Turn'`
  (opencode), `'Turn'` (générique). Adapter `sessionDurationSemantics` sans
  changer les autres champs.
- Ajouter `countLabel(count, noun)` (pluriel en `s` simple ; pas d'i18n).
- Ajouter `sessionDurationCaption` selon le contrat normatif (quatre parts
  ordonnées, bornes conditionnées à `durationStatus === 'partial'`, labels et
  hints repris de la sémantique, valeurs via `formatSessionDuration` et
  `String(burstCount)`).

Tests dans `session-analysis.test.ts` : table codex/opencode/générique ×
recorded/partial ; `countLabel(1, 'prompt') === '1 prompt'`,
`countLabel(2, 'prompt') === '2 prompts'`, `countLabel(0, 'tool') === '0 tools'`.

### Step 1.2 — `buildSessionTimelineRows`

Implémenter la jointure turns ↔ prompts selon les règles normatives. Tests
obligatoires :

1. session nominale : n tâches, chacune avec son prompt, ordre chronologique ;
2. tâche sans prompt (label retombera sur `rowNoun`) ;
3. prompt orphelin → ligne `orphan-prompt` insérée à sa position
   chronologique ;
4. prompt référencé par deux tâches → rattaché uniquement à la première ;
5. `promptId` sans prompt correspondant → ignoré sans erreur ;
6. `tokenShareOfMax` : valeurs exactes, cas max = 0 → 0 partout, jamais `NaN` ;
7. `detail.turns` vide mais prompts présents → uniquement des lignes
   `orphan-prompt`.

### Step 1.3 — Échelle compressée

Implémenter `buildTimelineScale`, `positionOnScale`,
`timelineHasCompressibleGaps` et `GAP_COMPRESSION_THRESHOLD_MS` selon les
règles normatives. Tests obligatoires :

1. parité wall-clock : pour une grille d'intervalles, `positionOnScale`
   égale `positionOnTimeline` ;
2. session dense (aucun gap > 15 min) : mode compressé identique au
   wall-clock, `breaks` vide, `timelineHasCompressibleGaps === false` ;
3. session 18 h avec deux gaps de 5 h et 3 h : deux `breaks`, chaque gap rendu
   à 2 %, blocs proportionnels à leur durée réelle, somme des largeurs = 100 ;
4. monotonicité et clamp : instants hors bornes clampés, jamais de largeur
   négative ;
5. session à durée nulle (`startedAt === endedAt`) : pas de division par
   zéro, comportement identique à `positionOnTimeline` (0 / 100).

**Verify** :

~~~sh
bun test apps/web/src/session-analysis.test.ts
bun run typecheck
~~~

**Expected** : tests verts ; aucun changement hors
`session-analysis-model.ts` et son test ; les exports existants
(`positionOnTimeline`, `countActivityBursts`, `phaseTokenShare`,
`formatSessionDuration`) restent intacts car `session-analysis.tsx` les
consomme encore jusqu'au lot B.

## Work package 2 — Refonte du composant SessionAnalysis

**Owner** : Agent B. Fichiers : `apps/web/src/session-analysis.tsx`,
`apps/web/src/session-analysis.render.test.tsx`.

### Step 2.1 — Restructurer les sections

- Supprimer le `<dl>` de quatre tuiles (lignes 482-494 actuelles) et
  `metricItems`. Rendre la caption `sessionDurationCaption` dans le header de
  la section timeline : chaque part dans un
  `<span data-session-analysis-metric="<key>" title={hint}>` avec le préfixe
  ≥ / ≤ + sr-only « At least / At most » (réutiliser la logique de
  `MetricValue`, adaptée en inline).
- Fusionner les sections turns et prompts en une section unique
  `aria-labelledby="session-timeline"`, heading = `timelineHeading` existant.
  Les items `partial-turns`, `privacy` puis `prompt-truncation` se rendent
  dans le header de cette section ; `partial-duration` reste à côté de la
  caption. Aucune modification de
  `session-analysis-presentation.ts`.
- Section phases : envelopper dans
  `<Show when={chronologicalPhases().length > 1}>` ; ajouter le fallback
  mono-phase : une ligne `muted` avec le dot de couleur, `model · effort ·
  100% tokens · cost` (mêmes formatteurs que `PhaseRow`). La bande multi-phase
  utilise `positionOnScale` avec la même échelle que la timeline.
- États vides : aucune ligne (`buildSessionTimelineRows` vide) → conserver un
  `EmptyTimeline` avec le texte actuel « No turn intervals were available in
  local history. » ; garder le fallback prompts absent via le même bloc.

### Step 2.2 — Lignes unifiées et colonne tokens

- Grille md+ des lignes et de l'axe :
  `minmax(220px, 0.42fr) minmax(0, 1fr) minmax(72px, 0.16fr)` ; l'axe gagne un
  troisième en-tête `Tokens` (`axisLabels` réutilisé) ; en base, tout
  s'empile comme aujourd'hui.
- Ligne `task` : `<details>` en colonne label ; `<summary>` = chevron ▶ +
  préview (`promptPreviewText` du prompt principal, sinon
  `${rowNoun} ${index + 1}`) + durée ; méta en dessous :
  `countLabel(tokens…)` compact, `countLabel(tools, 'tool')`,
  `countLabel(prompts.length, 'prompt')`, et `model · effort` seulement si la
  session a ≥ 2 phases distinctes. Le corps du `<details>` liste chaque prompt
  complet (timestamp, pill « Truncated » conservée, corps mono actuel).
- Piste : intervalles via `positionOnScale` ; quand ≥ 2 phases, classe de
  couleur `phaseTone` de la phase couvrant `startAt` de la tâche (fallback
  `turnBar` sinon).
- Colonne tokens : piste dédiée avec barre `width:
  ${row.tokenShareOfMax * 100}%` + valeur `fmtTokens` ; `—` pour les lignes
  `orphan-prompt` ; `aria-hidden` sur la barre, la valeur textuelle porte
  l'information.
- Ligne `orphan-prompt` : marqueur ponctuel positionné à son timestamp
  (`positionOnScale(t, t)`, largeur min visuelle), disclosure identique.
- Bascule d'échelle : état local `createSignal<TimelineScaleMode>` initialisé
  à `'compressed'` ; bouton visible seulement si
  `timelineHasCompressibleGaps`, texte « Show real gaps » /
  « Compress gaps », `aria-pressed`, `data-session-analysis-scale` exposant le
  mode courant. Ruptures : marqueur `⫽` positionné à `atPercent`, `title` =
  durée du gap.
- `aria-label` de piste par ligne : préview du prompt (ou rowNoun N), durée
  avec `turnSpanNoun`, tokens, tools, bornes temporelles — même granularité
  que l'actuel `accessibleLabel`.
- Corrections de détail : pluriels via `countLabel` partout dans la section ;
  coût de phase : 2 décimales si `>= 1`, 4 sinon (deux `Intl.NumberFormat`
  top-level, pas de formatteur créé dans le rendu).

### Step 2.3 — Mettre à jour les tests de rendu

Adapter les treize tests existants (mêmes assertions de tones/roles, nouveaux
sélecteurs de section) et ajouter :

1. session mono-phase : pas de bande phases, la ligne de légende contient
   `100%` et le coût à 2 décimales pour un coût ≥ $1 ;
2. session bi-phase : bande présente, deux couleurs de piste distinctes dans
   les lignes ;
3. ligne task avec prompt : le `<summary>` contient la préview, pas
   `Task 1` ; ligne task sans prompt : `Task 1` (harness codex) et `Turn 1`
   (harness opencode) ;
4. prompt orphelin : une ligne `orphan-prompt` rendue avec `—` en colonne
   tokens ;
5. pluriels : `1 prompt` et `1 tool` sans `s` ;
6. caption : les quatre `data-session-analysis-metric` présents, `≥` sur
   `active` et `≤` sur `gap` quand `durationStatus: 'partial'`, absents
   sinon ;
7. échelle : fixture avec gap de 5 h → `data-session-analysis-scale="compressed"`
   et au moins un marqueur `⫽` dans le markup ; fixture dense → pas de bouton
   de bascule ;
8. les kinds `privacy` et `prompt-truncation` se rendent dans la section
   `session-timeline` avec `data-tone="neutral"` et sans `role="status"` ;
9. aucun rendu ne contient `Turn undefined`, `NaN`, ni « may be newer ».

**Verify** :

~~~sh
bun test apps/web/src/session-analysis.render.test.tsx \
  apps/web/src/session-analysis-presentation.test.ts \
  apps/web/src/session-analysis.test.ts
bun run check
bun run typecheck
~~~

**Expected** : exit 0 ; `session-analysis-presentation.ts` sans diff ;
`grep -n "session-prompts\|session-turn-timeline" apps/web/src/session-analysis.tsx`
ne retourne rien (remplacés par `session-timeline` et `session-model-phases`
conservé).

## Work package 3 — Drawer vue unique et E2E

**Owner** : Agent C. Fichiers : `apps/web/src/session-drawer.tsx`,
`apps/web/e2e/production-report.spec.ts`.

### Step 3.1 — Fusionner les deux corps du drawer

- Rendre le résumé inconditionnellement ; déplacer le bloc
  `<Show when={analysisOpen()}>` + `SessionAnalysis` à la fin du même
  `drawerBody` (mêmes props, même `SESSION_ANALYSIS_PANEL_ID`).
- Labels du bouton : fermé → « Analyze » / « Analyze root » avec les
  aria-labels actuels ; ouvert → « Hide analysis », aria
  « Hide session chronology ». `aria-expanded`/`aria-controls` conservés.
- `toggleAnalysis` : à l'ouverture, après le chargement, faire défiler le
  panneau dans la vue (`scrollIntoView({ block: 'nearest' })` sur l'élément du
  panneau) ; à la fermeture, comportement actuel (reset des états).
- `analysisDrawer` (960 px) continue de s'appliquer quand `analysisOpen()`.
- Le reset sur changement de ligne (`createEffect` sur `rowKey`, lignes
  108-115) reste tel quel.

### Step 3.2 — Mettre à jour le smoke production

Dans `production-report.spec.ts:270-296`, en conservant toutes les assertions
de sentinel, consistency et privacy :

1. après le clic « Analyze root session chronology », vérifier que le résumé
   reste visible : `rootDrawer.locator('[aria-label="Token anatomy"]')`
   visible en même temps que la région « Session analysis » ;
2. remplacer le sélecteur de section prompts par
   `sessionAnalysis.locator('section[aria-labelledby="session-timeline"]')`
   pour le sentinel et l'item `privacy` ;
3. remplacer les assertions de tuiles par :
   `[data-session-analysis-metric="active"]` contient `≥` et
   `[data-session-analysis-metric="gap"]` contient `≤` ;
4. ajouter : le bouton « Hide analysis » est visible quand la section est
   ouverte ; un second clic masque la région « Session analysis » mais laisse
   le drawer et le résumé ouverts ;
5. si la fixture root comporte un gap compressible, vérifier
   `[data-session-analysis-scale="compressed"]` ; sinon vérifier l'absence du
   bouton de bascule (choisir selon la fixture réelle, ne pas forcer).

Ne pas ajouter de nouveau fichier spec ni de nouveau scénario complet.

**Verify** :

~~~sh
bun run test:e2e
bun run test:e2e-production
~~~

**Expected** : suites vertes ; le sentinel reste absent du HTML initial et
présent une seule fois après la demande ; aucune assertion `data-tone` du plan
025 n'a été supprimée.

## Work package 4 — Documentation, gates et clôture

**Owner** : Agent D / coordinateur.

### Step 4.1 — Documenter la vue unifiée

Dans `docs/session-analysis-sources.md`, mettre à jour la description de l'UI :

- une seule vue de session : résumé toujours visible, chronologie locale
  chargée à la demande dans le même drawer ;
- timeline unifiée : une ligne par tâche, prompt comme label, colonne tokens
  alignée, phases en bande seulement au-delà d'une phase ;
- échelle compressée par défaut avec ruptures marquées, bascule wall-clock,
  et la règle d'honnêteté : la compression change l'affichage, jamais les
  valeurs ;
- vocabulaire `Task` (Codex) / `Turn` (OpenCode) aligné sur
  `SessionDurationSemantics`.

Garde-fou :

~~~sh
grep -RIn "Analyze root\|Summary view\|two views" docs/session-analysis-sources.md
~~~

Aucune mention résiduelle d'un mode « Summary » séparé.

### Step 4.2 — Gates finaux

~~~sh
bun install --frozen-lockfile
bun run check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e
bun run test:e2e-production
git diff --check b24f6a2...HEAD
git status --short
~~~

**Expected** : chaque commande sort 0 ; `bun.lock` inchangé ; seuls les
fichiers de scope, le log et l'index sont modifiés (plus le fichier CLI déjà
modifié par l'utilisateur, laissé intact). Mettre à jour le log, puis passer
la row 026 de `plans/README.md` à `DONE`.

## Test plan consolidé

### Unitaires purs (`session-analysis.test.ts`)

- jointure turns/prompts : nominal, sans prompt, orphelin, double référence,
  id inconnu, turns vides ;
- `tokenShareOfMax` exact, max nul, jamais `NaN` ;
- échelle : parité wall-clock, identité sans gap, compression 2 %, breaks,
  monotonicité, clamp, durée nulle ;
- caption : quatre parts ordonnées, bornes partial, labels par harness ;
- `countLabel` et `rowNoun` par harness.

### Rendu SSR (`session-analysis.render.test.tsx`)

- treize cas existants adaptés (tones, rôles, kinds inchangés) ;
- mono-phase → légende, multi-phase → bande + pistes colorées ;
- labels de lignes (prompt / `Task N` / `Turn N`), orphelins, pluriels ;
- caption `data-session-analysis-metric` avec et sans bornes ;
- mode d'échelle par défaut, marqueurs de rupture, bouton conditionnel ;
- coût 2 décimales ≥ $1 ; aucun « may be newer », `NaN` ou `Turn undefined`.

### Navigateur

- smoke production : résumé et chronologie visibles simultanément, sentinel
  local-only intact, consistency/privacy neutres, métriques bornées via
  `data-session-analysis-metric`, ouverture/fermeture de section ;
- suite dev `test:e2e` sans régression drawer/navigation.

## Done criteria

Tous les critères doivent être vrais :

- [ ] Le drawer n'a plus qu'une vue : le résumé reste visible pendant que la
      chronologie est ouverte, dans le même scroll.
- [ ] La chronologie n'est chargée qu'après une action explicite ; le sentinel
      de prompt reste absent du HTML initial et n'apparaît qu'à la demande.
- [ ] Turns et prompts sont une seule timeline ; chaque prompt apparaît
      exactement une fois ; les tâches sans prompt et les prompts orphelins
      sont rendus sans association inventée.
- [ ] Une colonne tokens alignée rend le volume comparable entre lignes.
- [ ] La bande de phases n'apparaît qu'à partir de deux phases ; en
      mono-phase, une ligne de légende la remplace ; en multi-phase, les
      pistes prennent la couleur de leur phase.
- [ ] Les quatre tuiles sont remplacées par une caption bornée
      (`data-session-analysis-metric`, ≥/≤, sr-only) au-dessus de la timeline.
- [ ] L'échelle compressée est le défaut quand un gap > 15 min existe, chaque
      rupture est marquée et titrée, la bascule wall-clock fonctionne, et
      aucune valeur affichée ne change avec le mode.
- [ ] `Task N` (Codex) / `Turn N` (OpenCode) via `rowNoun` ; plus aucun
      `Turn N` pour une tâche Codex.
- [ ] Pluriels corrects, coût de phase à 2 décimales dès $1, modèle/effort par
      ligne seulement en multi-phase.
- [ ] Les kinds et tones de `buildSessionAnalysisPresentation` sont inchangés
      et toujours prouvés par les tests de rendu ; scope et privacy jamais en
      warning.
- [ ] `bun run check`, lint, typecheck, tests, build et les deux suites E2E
      passent ; `git diff --check` est vide.
- [ ] Le log contient les quatre commits et la row 026 est `DONE`.

## STOP conditions

STOP et rapporter, sans improviser, si :

- les fichiers de portée ont matériellement dérivé depuis `b24f6a2` ;
- la refonte exige de modifier `SessionDetail`, la consistency, le client
  (`loadSessionDetail`), le serveur ou tout package hors `apps/web` ;
- préserver l'invariant de confidentialité impose de charger les prompts sans
  action explicite de l'utilisateur ;
- l'échelle compressée ne peut pas rester un pur changement d'affichage
  (par exemple si une valeur affichée devait changer selon le mode) ;
- un style indispensable ne peut exister qu'en modifiant
  `@ai-usage/design-system` ;
- le smoke production échoue deux fois après une correction raisonnable ;
- la complexité cognitive de `session-analysis.tsx` force à désactiver une
  règle Ultracite au lieu d'extraire des sous-composants ;
- un agent doit toucher un fichier possédé par un lot non intégré.

## Maintenance notes

- Tout nouveau harness supporté par le détail doit définir son `rowNoun` et
  ses textes dans `SessionDurationSemantics` avant d'apparaître dans l'UI ; le
  JSX ne doit jamais encoder de vocabulaire harness-spécifique.
- `GAP_COMPRESSION_THRESHOLD_MS` est une constante produit : si elle change,
  mettre à jour le test d'identité (session dense) et la doc.
- La colonne tokens normalise sur la tâche max de la session ; si un futur
  besoin exige une normalisation croisée entre sessions, c'est un nouveau
  design, pas un paramètre à ajouter ici.
- Le reviewer doit particulièrement vérifier : la simultanéité résumé +
  chronologie, l'unicité d'apparition de chaque prompt, l'absence de fausse
  association prompt↔tâche, l'honnêteté des ruptures d'échelle et la
  conservation exacte des contrats `data-session-analysis-item`/`data-tone`.
