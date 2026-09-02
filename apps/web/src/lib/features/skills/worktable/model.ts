import type { SkillManagementSnapshot } from '@ai-usage/skills';
import {
  buildProjectSkillRows,
  count,
  describeProjectSkillPlacement,
  type KnownProjectScope,
  type MatrixCellState,
  projectRouteKey,
  type SkillTreeScopeNode,
  skillInvocation,
} from '../../../../skills-page-model';
import { MATRIX_DOT_GLYPHS, type MatrixDotTone, matrixDotTone } from '../management/model';
import {
  compareObservationRows,
  formatObservedDate,
  harnessInvocationEvidenceComplete,
  harnessSignalsComplete,
  OBSERVATION_ROW_OMITTED_TEXT,
  observationEvidenceRank,
  observationRecency,
  observationRecencyNote,
  type SkillCatalogueRollup,
  type SkillObservationRow,
  type SkillObservationsView,
} from '../observations/model';
import type { SkillsObservationPresentation, SkillsPresentationProjection } from '../presentation';
import type { SkillsShellViewModel } from '../shell/model';

/**
 * The worktable: one row per skill name, grouped by the decision the name is waiting on.
 *
 * The join this module performs is the one neither the exposure matrix nor the observation table
 * ever made — *placement* (where a skill is installed, per harness) beside *evidence* (how often it
 * was actually invoked there, per harness). Both were already computed; they lived on two pages.
 *
 * Two notations, and only two, appear in a cell (plan 113 decision 4): a plain number is an
 * invocation the harness recorded, a tilde-prefixed number is one reconstructed from a weaker
 * trace. They are never added together (ADR 0022). "Offered to a model" counts are availability,
 * not use, and are excluded from every cell here — they live in the drawer and the catalogue group.
 */

/** How many adoption candidates the table shows before folding the rest away. */
export const WORKTABLE_ADOPTION_PREVIEW_LIMIT = 6;

export type SkillsWorktableFilterId = 'all' | 'catalogue-only' | 'links-healthy' | 'to-adopt' | 'to-delete';

export type SkillsWorktableGroupId = 'catalogue' | 'managed' | 'projects' | 'to-adopt';

export interface SkillsWorktableFilter {
  /** Spoken form of `value`, so a screen reader never hears a bare fraction. */
  readonly accessibleValue: string;
  readonly id: SkillsWorktableFilterId;
  readonly label: string;
  /** The groups this filter keeps. `all` keeps every group. */
  readonly value: string;
}

/**
 * One column of the worktable: a placement target, the harness that can report on it, or both.
 *
 * Columns are the enabled placement targets first — that is what a managed row can act on — plus
 * any observable harness with no target of its own, so a harness that records invocations never
 * loses them for want of a configured directory.
 */
export interface SkillsWorktableColumn {
  readonly harnessKey: string | undefined;
  readonly key: string;
  readonly label: string;
  readonly targetId: string | undefined;
}

/** One invocation count, in the table's notation and in words. */
export interface SkillsWorktableEvidence {
  readonly accessibleText: string;
  readonly text: string;
  readonly tier: 'declared' | 'inferred';
}

export interface SkillsWorktableCell {
  readonly columnKey: string;
  readonly evidence: readonly SkillsWorktableEvidence[];
  /** The letterform placement mark, or `undefined` where the column is not a placement target. */
  readonly glyph: string | undefined;
  readonly placementLabel: string | undefined;
  readonly tone: MatrixDotTone | undefined;
}

export type SkillsWorktableRowKind = 'adoption' | 'managed' | 'project-skill';

export interface SkillsWorktableSkillRow {
  readonly cells: readonly SkillsWorktableCell[];
  readonly description: string;
  readonly enabled: boolean;
  /** The drawer URL, or `undefined` for a name this product has no detail route for. */
  readonly href: string | undefined;
  readonly invocationLabel: 'Auto' | 'Manual';
  readonly issueCount: number;
  readonly kind: SkillsWorktableRowKind;
  readonly lastObservedAt: string | null;
  readonly lastSignalRecency: 'aging' | 'fresh' | 'stale' | undefined;
  readonly lastSignalStale: boolean;
  readonly lastSignalText: string;
  readonly name: string;
  readonly observationRowOmitted: boolean;
  readonly residence: string;
  readonly validationStatus: string;
}

export interface SkillsWorktableProjectRow {
  readonly expandedRows: readonly SkillsWorktableSkillRow[];
  readonly href: string;
  readonly key: string;
  readonly label: string;
  readonly lastSignalText: string;
  readonly observedCount: number;
  readonly observedCountLowerBound: boolean;
  readonly shortPath: string;
  readonly skillCount: number;
  /** `13 with invocation evidence — top: agent-browser (~17 Codex · 3 OpenCode)`, or the absence. */
  readonly summary: string;
}

export interface SkillsWorktableCatalogueGroup {
  readonly description: string;
  readonly emptyText: string;
  readonly entryCount: number;
  readonly entryCountText: string;
  /** `Folded by catalogue — vercel 53 · anthropic 21 · 25 others` */
  readonly foldSummary: string;
  readonly rollups: readonly SkillsWorktableCatalogueRollup[];
}

export interface SkillsWorktableCatalogueRollup extends SkillCatalogueRollup {
  readonly entryCountText: string;
}

export interface SkillsWorktableAdoptionGroup {
  readonly emptyText: string;
  readonly externalRows: readonly SkillsWorktableSkillRow[];
  readonly foldedRows: readonly SkillsWorktableSkillRow[];
  readonly previewRows: readonly SkillsWorktableSkillRow[];
  readonly total: number;
  readonly totalText: string;
}

export interface SkillsWorktableModel {
  readonly adoption: SkillsWorktableAdoptionGroup;
  readonly catalogue: SkillsWorktableCatalogueGroup;
  readonly columns: readonly SkillsWorktableColumn[];
  readonly deletionCandidateNames: ReadonlySet<string>;
  readonly deletionCandidatesProvisional: boolean;
  readonly filters: readonly SkillsWorktableFilter[];
  readonly headline: string;
  readonly managedRows: readonly SkillsWorktableSkillRow[];
  readonly observability: readonly { readonly label: string; readonly observable: boolean }[];
  readonly projectRows: readonly SkillsWorktableProjectRow[];
  readonly projectSkillCount: number;
}

const NOT_OBSERVABLE_COLUMN_LABEL = 'not observable';

/**
 * The one line that teaches both notations, kept beside the strip rather than in a legend nobody
 * scrolls to. It names the arithmetic it forbids, because that is the mistake the two notations
 * exist to prevent.
 */
export const WORKTABLE_EVIDENCE_NOTATION_TEXT =
  '10 recorded invocations · ~10 reconstructed from traces — never added together.';

export const WORKTABLE_NAME_SCOPE_TEXT =
  'Counts are name-scoped and cover every installation sharing the name. Row click opens the skill drawer — exposure spelled out, observations, SKILL.md editor.';

export const WORKTABLE_PLACEMENT_LEGEND: readonly { readonly label: string; readonly tone: MatrixDotTone }[] = [
  { label: 'linked', tone: 'linked' },
  { label: 'copy', tone: 'copy' },
  { label: 'to link', tone: 'missing' },
  { label: 'broken', tone: 'broken' },
  { label: 'absent', tone: 'none' },
];

export const worktableGlyph = (tone: MatrixDotTone): string => MATRIX_DOT_GLYPHS[tone];

const declaredText = (value: number, lowerBound: boolean): string => `${lowerBound ? '≥' : ''}${value}`;

/**
 * A tilde, not an abbreviation. `inf 217` needed a legend on every read; `~217` needs one sentence,
 * and the accessible name still says "reconstructed from traces" in words.
 */
const inferredText = (value: number, lowerBound: boolean): string => `~${lowerBound ? '≥' : ''}${value}`;

const evidenceFor = (
  row: Pick<SkillObservationRow, 'tallies'>,
  harnessKey: string,
  harnessLabel: string,
  invocationLowerBound: boolean,
): readonly SkillsWorktableEvidence[] => {
  const tallies = row.tallies.filter((tally) => tally.harnessKey === harnessKey);
  const declared = tallies.find((tally) => tally.tier === 'declared');
  const inferred = tallies.find((tally) => tally.tier === 'inferred');
  const bound = invocationLowerBound ? 'at least ' : '';
  return [
    ...(declared === undefined
      ? []
      : [
          {
            accessibleText: `${bound}${declared.count} recorded ${declared.count === 1 ? 'invocation' : 'invocations'} in ${harnessLabel}`,
            text: declaredText(declared.count, invocationLowerBound),
            tier: 'declared' as const,
          },
        ]),
    ...(inferred === undefined
      ? []
      : [
          {
            accessibleText: `${bound}${inferred.count} ${inferred.count === 1 ? 'invocation' : 'invocations'} reconstructed from traces in ${harnessLabel}`,
            text: inferredText(inferred.count, invocationLowerBound),
            tier: 'inferred' as const,
          },
        ]),
  ];
};

/**
 * Placement target id → observable harness key, for the ids that do not already spell the key.
 *
 * Declared, not inferred. The join used to fall back to a case-insensitive comparison of the two
 * display labels, which made which-counts-land-in-which-column a function of display copy: rename
 * either label and the counts do not disappear, they split into a second column carrying an
 * identical label, because `buildColumns` appends every observable harness no target claimed. Two
 * identically-labelled columns is a silent presentation defect — nothing errors, the reader just
 * sees one harness twice. A label match could never help a custom target either, since a custom
 * target's label is title-cased from its own id (`targetLabelFor`), so `my-claude` reads
 * `My Claude` and matches nothing. An id this table does not name resolves to no harness.
 *
 * The table belongs here, in the presentation layer: `@ai-usage/skills` deliberately does not
 * depend on `@ai-usage/report-core`, so neither package can own the correspondence between a
 * placement target and a harness.
 */
const HARNESS_KEY_BY_TARGET_ID: ReadonlyMap<string, string> = new Map([['claude-code', 'claude']]);

const buildColumns = (
  snapshot: SkillManagementSnapshot,
  view: SkillObservationsView | undefined,
): readonly SkillsWorktableColumn[] => {
  const harnesses = view?.observableHarnesses ?? [];
  // A target id equal to a harness key resolves to that harness; anything else must be declared.
  const harnessFor = (targetId: string): string | undefined => {
    const harnessKey = HARNESS_KEY_BY_TARGET_ID.get(targetId) ?? targetId;
    return harnesses.find((harness) => harness.harnessKey === harnessKey)?.harnessKey;
  };
  const targetColumns = snapshot.targets
    .filter((target) => target.enabled)
    .map((target) => ({
      harnessKey: harnessFor(target.id),
      key: `target:${target.id}`,
      label: target.label,
      targetId: target.id,
    }));
  const claimedHarnesses = new Set(targetColumns.flatMap((column) => (column.harnessKey ? [column.harnessKey] : [])));
  const harnessOnlyColumns = harnesses
    .filter((harness) => !claimedHarnesses.has(harness.harnessKey))
    .map((harness) => ({
      harnessKey: harness.harnessKey,
      key: `harness:${harness.harnessKey}`,
      label: harness.label,
      targetId: undefined,
    }));
  return [...targetColumns, ...harnessOnlyColumns];
};

const projectionStateFor = (snapshot: SkillManagementSnapshot, skillName: string, targetId: string): MatrixCellState =>
  snapshot.projections.find((projection) => projection.skillName === skillName && projection.targetId === targetId)
    ?.state ?? 'missing';

const placementLabelFor = (state: MatrixCellState): string => {
  const tone = matrixDotTone(state);
  return WORKTABLE_PLACEMENT_LEGEND.find((entry) => entry.tone === tone)?.label ?? 'absent';
};

const lastSignalTextFor = (
  lastObservedAt: string | null,
  observations: SkillsObservationPresentation,
  observationRowOmitted = false,
): string => {
  if (observations.state === 'unavailable') {
    return 'observations unavailable';
  }
  if (observations.state === 'loading') {
    return 'loading observations…';
  }
  if (observationRowOmitted && lastObservedAt === null) {
    return OBSERVATION_ROW_OMITTED_TEXT;
  }
  if (lastObservedAt === null) {
    return observations.view?.signalsComplete === true ? 'no signal recorded' : 'no signal in loaded history';
  }
  const retained = observations.view?.lowerBound === true || observationRowOmitted;
  return `${retained ? 'latest retained' : 'last'} ${formatObservedDate(lastObservedAt)}`;
};

interface RowContext {
  readonly columns: readonly SkillsWorktableColumn[];
  readonly observations: SkillsObservationPresentation;
  readonly snapshot: SkillManagementSnapshot;
}

const cellsFor = (
  context: RowContext,
  input: {
    readonly enabled: boolean;
    readonly observationRow: SkillObservationRow | undefined;
    readonly placementTargets: boolean;
    readonly skillName: string;
  },
): readonly SkillsWorktableCell[] => {
  const view = context.observations.view;
  return context.columns.map((column) => {
    // A cell holds one harness's counts, so it is qualified by that harness's own evidence. Before
    // this, one Codex rejection rendered every Claude Code cell on the table as `≥`.
    const columnInvocationLowerBound =
      view !== undefined && column.harnessKey !== undefined
        ? !harnessInvocationEvidenceComplete(view, column.harnessKey)
        : false;
    const evidence =
      column.harnessKey === undefined || input.observationRow === undefined
        ? []
        : evidenceFor(input.observationRow, column.harnessKey, column.label, columnInvocationLowerBound);
    if (!input.placementTargets || column.targetId === undefined) {
      return { columnKey: column.key, evidence, glyph: undefined, placementLabel: undefined, tone: undefined };
    }
    // A disabled skill has no placement claim to make — every mark reads absent — but its
    // invocation history stays exactly where it was. Disabling never erases anything.
    const state: MatrixCellState = input.enabled
      ? projectionStateFor(context.snapshot, input.skillName, column.targetId)
      : 'not-applicable';
    const tone = matrixDotTone(state);
    return {
      columnKey: column.key,
      evidence,
      glyph: MATRIX_DOT_GLYPHS[tone],
      placementLabel: `${column.label} — ${placementLabelFor(state)}`,
      tone,
    };
  });
};

const buildManagedRows = (
  context: RowContext,
  presentation: SkillsPresentationProjection,
  snapshot: SkillManagementSnapshot,
): readonly SkillsWorktableSkillRow[] => {
  const attentionByName = new Map(presentation.attention.entries.map((entry) => [entry.skill.name, entry.attention]));
  return snapshot.skills
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((skill) => {
      const observationRow = context.observations.rowsByName.get(skill.name);
      return {
        cells: cellsFor(context, {
          enabled: skill.enabled,
          observationRow,
          placementTargets: true,
          skillName: skill.name,
        }),
        description: skill.description,
        enabled: skill.enabled,
        href: `/skills/global/${encodeURIComponent(skill.name)}`,
        invocationLabel: skillInvocation(skill) === 'auto' ? ('Auto' as const) : ('Manual' as const),
        issueCount: attentionByName.get(skill.name)?.issueCount ?? 0,
        kind: 'managed' as const,
        lastObservedAt: observationRow?.lastObservedAt ?? null,
        lastSignalRecency:
          observationRow?.lastObservedAt == null ? undefined : observationRecency(observationRow.lastObservedAt),
        lastSignalStale:
          observationRow?.lastObservedAt != null && observationRecencyNote(observationRow.lastObservedAt) !== undefined,
        lastSignalText: lastSignalTextFor(
          observationRow?.lastObservedAt ?? null,
          context.observations,
          context.observations.omittedSkillNames.has(skill.name),
        ),
        name: skill.name,
        observationRowOmitted: context.observations.omittedSkillNames.has(skill.name),
        residence: 'Managed — source of truth in the skills repository',
        validationStatus: skill.validationStatus,
      };
    });
};

const adoptionRowFrom = (context: RowContext, row: SkillObservationRow): SkillsWorktableSkillRow => ({
  cells: cellsFor(context, {
    enabled: true,
    observationRow: row,
    placementTargets: false,
    skillName: row.skillName,
  }),
  description: row.resolvedPaths.at(0) ?? '',
  enabled: true,
  href: undefined,
  invocationLabel: 'Auto',
  issueCount: 0,
  kind: 'adoption',
  lastObservedAt: row.lastObservedAt,
  lastSignalRecency: row.lastObservedAt === null ? undefined : observationRecency(row.lastObservedAt),
  lastSignalStale: row.lastObservedAt !== null && observationRecencyNote(row.lastObservedAt) !== undefined,
  lastSignalText: lastSignalTextFor(row.lastObservedAt, context.observations),
  name: row.skillName,
  observationRowOmitted: false,
  residence:
    row.unmanagedResidence === 'runtime-installed'
      ? 'Installed in a runtime skills directory, outside any source repository'
      : 'Ships with a harness or one of its plugins',
  validationStatus: 'valid',
});

const projectSkillRowsFor = (
  context: RowContext,
  scope: SkillTreeScopeNode,
  view: SkillsShellViewModel,
): readonly SkillsWorktableSkillRow[] => {
  const sourcePaths = new Set(scope.sourcePaths ?? (scope.path === undefined ? [] : [scope.path]));
  const inventories = view.inventories.filter((inventory) => sourcePaths.has(inventory.projectPath));
  const projectKey = scope.path === undefined ? scope.key : projectRouteKey(scope.path, view.knownProjects);
  return buildProjectSkillRows(inventories, view.knownProjects).map((row) => {
    const observationRow = context.observations.rowsByName.get(row.name);
    return {
      cells: cellsFor(context, {
        enabled: true,
        observationRow,
        placementTargets: false,
        skillName: row.name,
      }),
      description: row.description,
      enabled: true,
      href: `/skills/projects/${encodeURIComponent(projectKey)}/${encodeURIComponent(row.name)}`,
      invocationLabel: row.invocation === 'auto' ? ('Auto' as const) : ('Manual' as const),
      issueCount: 0,
      kind: 'project-skill' as const,
      lastObservedAt: observationRow?.lastObservedAt ?? null,
      lastSignalRecency:
        observationRow?.lastObservedAt == null ? undefined : observationRecency(observationRow.lastObservedAt),
      lastSignalStale:
        observationRow?.lastObservedAt != null && observationRecencyNote(observationRow.lastObservedAt) !== undefined,
      lastSignalText: lastSignalTextFor(
        observationRow?.lastObservedAt ?? null,
        context.observations,
        context.observations.omittedSkillNames.has(row.name),
      ),
      name: row.name,
      observationRowOmitted: context.observations.omittedSkillNames.has(row.name),
      residence: [...new Set(row.observations.map((observation) => describeProjectSkillPlacement(observation)))].join(
        ' · ',
      ),
      validationStatus: row.validationStatus,
    };
  });
};

/** `~17 Codex · 3 OpenCode` — one phrase per harness and tier, never a total. */
const topEvidenceSummary = (row: SkillsWorktableSkillRow, columns: readonly SkillsWorktableColumn[]): string => {
  const labelByColumnKey = new Map(columns.map((column) => [column.key, column.label]));
  return row.cells
    .flatMap((cell) =>
      cell.evidence.map((entry) => `${entry.text} ${labelByColumnKey.get(cell.columnKey) ?? ''}`.trim()),
    )
    .join(' · ');
};

/**
 * What one repository's row says about the skills inside it.
 *
 * The read's own state comes first: an unavailable or still-loading observation read must not be
 * reported as "no invocation evidence", which is a claim about the repository rather than about
 * the read.
 */
const projectSummaryText = (input: {
  readonly columns: readonly SkillsWorktableColumn[];
  readonly observationsState: SkillsObservationPresentation['state'];
  readonly observed: number;
  readonly observedCountLowerBound: boolean;
  readonly top: SkillsWorktableSkillRow | undefined;
}): string => {
  if (input.observationsState === 'unavailable') {
    return 'Skill observations unavailable';
  }
  if (input.observationsState === 'loading') {
    return 'Loading skill observations…';
  }
  if (input.top === undefined) {
    return input.observedCountLowerBound
      ? 'No invocation evidence in loaded history; the retained project count is provisional'
      : 'No invocation evidence for the skills in this repository';
  }
  const prefix = input.observedCountLowerBound ? 'At least ' : '';
  const topLabel = input.observedCountLowerBound ? 'top retained' : 'top';
  return `${prefix}${input.observed} with invocation evidence — ${topLabel}: ${input.top.name} (${topEvidenceSummary(input.top, input.columns)})`;
};

const buildProjectRows = (
  context: RowContext,
  view: SkillsShellViewModel,
  knownProjects: readonly KnownProjectScope[],
): readonly SkillsWorktableProjectRow[] =>
  view.tree.scopes
    .filter((scope) => scope.type === 'project' && scope.hasSkills)
    .map((scope) => {
      const rows = projectSkillRowsFor(context, scope, view);
      const observed = rows.filter((row) => row.cells.some((cell) => cell.evidence.length > 0));
      const top = observed
        .toSorted((left, right) => (right.lastObservedAt ?? '').localeCompare(left.lastObservedAt ?? ''))
        .at(0);
      const lastObservedAt = rows.reduce<string | null>(
        (latest, row) =>
          row.lastObservedAt !== null && row.lastObservedAt > (latest ?? '') ? row.lastObservedAt : latest,
        null,
      );
      const observationRowsOmitted = rows.some((row) => row.observationRowOmitted);
      const observedCountLowerBound =
        observationRowsOmitted || context.observations.view?.invocationLowerBound === true;
      const projectPath = scope.path ?? scope.key;
      return {
        expandedRows: rows,
        href: `/skills/projects/${encodeURIComponent(projectRouteKey(projectPath, knownProjects))}`,
        key: scope.key,
        label: scope.label,
        lastSignalText: lastSignalTextFor(lastObservedAt, context.observations, observationRowsOmitted),
        observedCount: observed.length,
        observedCountLowerBound,
        shortPath: scope.shortPath ?? projectPath,
        skillCount: rows.length,
        summary: projectSummaryText({
          columns: context.columns,
          observationsState: context.observations.state,
          observed: observed.length,
          observedCountLowerBound,
          top,
        }),
      };
    })
    .toSorted((left, right) => right.observedCount - left.observedCount || left.label.localeCompare(right.label));

const cataloguePopulationText = (value: number, lowerBound: boolean, provisional: boolean): string => {
  const noun = value === 1 ? 'skill name' : 'skill names';
  if (provisional) {
    return `${value} provisional ${noun}`;
  }
  return `${lowerBound ? '≥' : ''}${value} ${noun}`;
};

const catalogueEmptyText = (lowerBound: boolean, provisional: boolean): string => {
  if (provisional) {
    return 'No catalogue-only row appears in loaded history; classification remains provisional.';
  }
  if (lowerBound) {
    return 'No catalogue-only row was retained in this incomplete response.';
  }
  return 'No name was offered to a model without an invocation also being recorded.';
};

const catalogueFoldSummary = (rollups: readonly SkillsWorktableCatalogueRollup[]): string => {
  const shown = rollups.slice(0, 3);
  const remainder = rollups.length - shown.length;
  const parts = shown.map((rollup) => `${rollup.label} ${rollup.entryCountText}`);
  return `Folded by catalogue — ${[...parts, ...(remainder > 0 ? [count(remainder, 'other')] : [])].join(' · ')}`;
};

export const createSkillsWorktableModel = (input: {
  readonly presentation: SkillsPresentationProjection;
  readonly view: SkillsShellViewModel;
}): SkillsWorktableModel => {
  const { presentation, view } = input;
  const snapshot = view.snapshot;
  const observationsView = presentation.observations.view;
  const observationsReady = presentation.observations.state === 'ready' && observationsView !== undefined;
  const unavailableValue = '—';
  const unavailableAccessibleValue =
    presentation.observations.state === 'unavailable' ? 'skill observations unavailable' : 'skill observations loading';
  const columns = buildColumns(snapshot, observationsView);
  const context: RowContext = { columns, observations: presentation.observations, snapshot };
  const managedRows = buildManagedRows(context, presentation, snapshot);
  const runtimeInstalled = (observationsView?.adoptionGroups ?? [])
    .filter((group) => group.residence === 'runtime-installed')
    .flatMap((group) => [...group.rows])
    .toSorted(compareObservationRows)
    .map((row) => adoptionRowFrom(context, row));
  // Harness- and plugin-shipped names are invoked too, and dropping them would hide real evidence.
  // They are not adoptable, so they sit behind their own fold rather than in the ranked backlog.
  const externalRows = (observationsView?.adoptionGroups ?? [])
    .filter((group) => group.residence === 'external')
    .flatMap((group) => [...group.rows])
    .toSorted(compareObservationRows)
    .map((row) => adoptionRowFrom(context, row));
  const projectRows = buildProjectRows(context, view, view.knownProjects);
  const projectSkillCount = projectRows.reduce((total, row) => total + row.skillCount, 0);
  const rawCatalogueRollups = observationsView?.catalogueRollups ?? [];
  const catalogueEntryCount = observationsView?.catalogueEntryCount ?? 0;
  const deletionCandidateNames = new Set((observationsView?.deletionCandidates ?? []).map((row) => row.skillName));
  const names = new Set<string>([
    ...managedRows.map((row) => row.name),
    ...runtimeInstalled.map((row) => row.name),
    ...externalRows.map((row) => row.name),
    ...projectRows.flatMap((project) => project.expandedRows.map((row) => row.name)),
    ...rawCatalogueRollups.flatMap((rollup) => rollup.rows.map((row) => row.skillName)),
  ]);
  const health = presentation.health;
  const managedObservationRowsOmitted = managedRows.some((row) => row.observationRowOmitted);
  const projectObservationRowsOmitted = projectRows.some((project) =>
    project.expandedRows.some((row) => row.observationRowOmitted),
  );
  const allNamesLowerBound = observationsView?.lowerBound === true;
  const adoptionLowerBound = observationsView?.invocationLowerBound === true;
  const deletionProvisional = observationsView?.invocationEvidenceComplete !== true || managedObservationRowsOmitted;
  const catalogueLowerBound = observationsView?.lowerBound === true;
  const catalogueProvisional = observationsView?.invocationEvidenceComplete !== true || projectObservationRowsOmitted;
  const catalogueRollups = rawCatalogueRollups.map((rollup) => ({
    ...rollup,
    entryCountText: cataloguePopulationText(rollup.rows.length, catalogueLowerBound, catalogueProvisional),
  }));
  const allNamesText = observationsReady ? `${allNamesLowerBound ? '≥' : ''}${names.size}` : unavailableValue;
  const headlineNameText = `${allNamesLowerBound ? 'At least ' : ''}${names.size} ${
    names.size === 1 ? 'skill name' : 'skill names'
  }`;
  const adoptionTotalText = observationsReady
    ? `${adoptionLowerBound ? '≥' : ''}${runtimeInstalled.length}`
    : unavailableValue;
  const deletionText = observationsReady
    ? `${deletionCandidateNames.size}${deletionProvisional ? ' provisional' : ''}`
    : unavailableValue;
  const deletionAccessibleValue = deletionProvisional
    ? `${deletionCandidateNames.size} provisional managed deletion candidates`
    : `${deletionCandidateNames.size} managed skills installed everywhere with no invocation evidence`;
  const catalogueNameNoun = catalogueEntryCount === 1 ? 'name' : 'names';
  const catalogueAccessibleValue = catalogueProvisional
    ? `${catalogueEntryCount} ${catalogueNameNoun} provisionally classified as offered-only`
    : `${catalogueLowerBound ? 'at least ' : ''}${catalogueEntryCount} ${catalogueNameNoun} only ever offered to a model`;
  const catalogueCountedText = catalogueProvisional
    ? `${catalogueEntryCount} provisional`
    : `${catalogueLowerBound ? '≥' : ''}${catalogueEntryCount}`;
  const catalogueEntryCountText = observationsReady ? catalogueCountedText : unavailableValue;
  const filters: readonly SkillsWorktableFilter[] = [
    {
      accessibleValue: observationsReady
        ? `${allNamesLowerBound ? 'at least ' : ''}${names.size} skill names`
        : unavailableAccessibleValue,
      id: 'all',
      label: 'All',
      value: allNamesText,
    },
    {
      accessibleValue: observationsReady
        ? `${adoptionLowerBound ? 'at least ' : ''}${runtimeInstalled.length} runtime-installed names with invocation evidence`
        : unavailableAccessibleValue,
      id: 'to-adopt',
      label: 'To adopt',
      value: adoptionTotalText,
    },
    {
      accessibleValue: `${health.healthyLinkCount} of ${health.expectedLinkCount} expected links are healthy`,
      id: 'links-healthy',
      label: 'Links healthy',
      value: `${health.healthyLinkCount}/${health.expectedLinkCount}`,
    },
    {
      accessibleValue: observationsReady ? deletionAccessibleValue : unavailableAccessibleValue,
      id: 'to-delete',
      label: 'To delete',
      value: deletionText,
    },
    {
      accessibleValue: observationsReady ? catalogueAccessibleValue : unavailableAccessibleValue,
      id: 'catalogue-only',
      label: 'Catalogue only',
      value: catalogueEntryCountText,
    },
  ];
  return {
    adoption: {
      emptyText: adoptionLowerBound
        ? 'No runtime-installed adoption candidate appears in loaded history.'
        : 'No runtime-installed name carries invocation evidence without a managed home.',
      externalRows,
      foldedRows: runtimeInstalled.slice(WORKTABLE_ADOPTION_PREVIEW_LIMIT),
      previewRows: runtimeInstalled.slice(0, WORKTABLE_ADOPTION_PREVIEW_LIMIT),
      total: runtimeInstalled.length,
      totalText: adoptionTotalText,
    },
    catalogue: {
      description: catalogueProvisional
        ? 'Offered to a model; no invocation in loaded history — classification is provisional'
        : 'Offered to a model, never invoked — availability is not use',
      emptyText: catalogueEmptyText(catalogueLowerBound, catalogueProvisional),
      entryCount: catalogueEntryCount,
      entryCountText: catalogueEntryCountText,
      foldSummary: catalogueFoldSummary(catalogueRollups),
      rollups: catalogueRollups,
    },
    columns,
    deletionCandidateNames,
    deletionCandidatesProvisional: deletionProvisional,
    filters,
    headline: [
      count(managedRows.length, 'managed skill'),
      ...(managedRows.some((row) => !row.enabled)
        ? [`${managedRows.filter((row) => !row.enabled).length} disabled`]
        : []),
      ...(observationsReady ? [headlineNameText] : []),
    ].join(' · '),
    managedRows,
    observability: (observationsView?.harnesses ?? []).map((harness) => ({
      label: harness.label,
      observable: harness.observability === 'observable',
    })),
    projectRows,
    projectSkillCount,
  };
};

const harnessEvidencePhrase = (
  cell: SkillObservationRow['harnesses'][number],
  view: SkillObservationsView,
): string | undefined => {
  const invocationLowerBound = !harnessInvocationEvidenceComplete(view, cell.harnessKey);
  const declared = cell.tallies.find((tally) => tally.tier === 'declared');
  const inferred = cell.tallies.find((tally) => tally.tier === 'inferred');
  const bound = invocationLowerBound ? 'at least ' : '';
  const parts = [
    ...(declared === undefined ? [] : [`${bound}${declared.count} recorded`]),
    ...(inferred === undefined ? [] : [`${bound}${inferred.count} reconstructed from traces`]),
  ];
  return parts.length === 0 ? undefined : `${cell.label} (${parts.join(', ')})`;
};

/**
 * The drawer's one plain-language sentence about the history.
 *
 * Every clause names its tier in words, because the drawer is where the table's `~` notation gets
 * spelled out. A harness that cannot report is never described as having seen nothing.
 */
export const worktableHistorySentence = (
  row: SkillObservationRow | undefined,
  view: SkillObservationsView | undefined,
): string => {
  if (view === undefined) {
    return 'Observation evidence is unavailable for this name.';
  }
  if (row === undefined) {
    return 'No observation row was carried for this name.';
  }
  // The "no invocation by *any* harness" clause is a cross-harness claim, so it keeps the global
  // bound: one harness's short evidence is enough to make it unprovable. The per-harness clauses
  // below are claims about one harness and use that harness's own answer.
  const invocationEvidenceComplete = view.invocationEvidenceComplete;
  const invoked = row.harnesses.flatMap((cell) => {
    const phrase = harnessEvidencePhrase(cell, view);
    return phrase === undefined ? [] : [phrase];
  });
  const silentCells = row.harnesses.filter((cell) => cell.state === 'no-observations');
  const silentRecorded = silentCells
    .filter((cell) => harnessSignalsComplete(view, cell.harnessKey))
    .map((cell) => cell.label);
  const silentLoaded = silentCells
    .filter((cell) => !harnessSignalsComplete(view, cell.harnessKey))
    .map((cell) => cell.label);
  const sentences = [
    invoked.length === 0
      ? `No invocation ${invocationEvidenceComplete ? 'recorded' : 'in loaded history'} by any harness that can report.`
      : `Invoked in ${invoked.join(' and ')}.`,
    ...(silentRecorded.length === 0 ? [] : [`No signal recorded for ${silentRecorded.join(', ')}.`]),
    ...(silentLoaded.length === 0 ? [] : [`No signal in loaded history for ${silentLoaded.join(', ')}.`]),
    ...(row.lastObservedAt === null
      ? []
      : [`${view.lowerBound ? 'Latest retained signal' : 'Last signal'} ${formatObservedDate(row.lastObservedAt)}.`]),
  ];
  return sentences.join(' ');
};

/**
 * The lower-bound caveat spelled out beside the drawer's exposure prose. It names the affected
 * evidence without guessing whether the loss came from rejection, truncation, or revalidation.
 */
export const worktableExposureCaveat = (view: SkillObservationsView | undefined): string | undefined => {
  if (view === undefined) {
    return;
  }
  if (view.onlyExposureTruncated) {
    return 'Exposure evidence is incomplete, so exposed counts are lower bounds.';
  }
  return view.lowerBound
    ? 'Observation evidence is incomplete, so declared, inferred, and exposed counts are lower bounds.'
    : undefined;
};

export const worktableObservabilityText = (observable: boolean): string =>
  observable ? 'observable' : NOT_OBSERVABLE_COLUMN_LABEL;

/** Whether a group is shown under the active decision filter. */
export const worktableGroupVisible = (filter: SkillsWorktableFilterId, group: SkillsWorktableGroupId): boolean => {
  if (filter === 'all') {
    return true;
  }
  if (filter === 'to-adopt') {
    return group === 'to-adopt';
  }
  if (filter === 'catalogue-only') {
    return group === 'catalogue';
  }
  return group === 'managed';
};

/** Whether a managed row survives the active decision filter. */
export const worktableManagedRowVisible = (
  filter: SkillsWorktableFilterId,
  row: SkillsWorktableSkillRow,
  deletionCandidateNames: ReadonlySet<string>,
): boolean => (filter === 'to-delete' ? deletionCandidateNames.has(row.name) : true);

export const worktableManagedEmptyText = (input: {
  readonly deletionCandidatesProvisional: boolean;
  readonly filter: SkillsWorktableFilterId;
  readonly observationsState: SkillsObservationPresentation['state'];
}): string => {
  if (input.observationsState === 'loading') {
    return 'Skill observation facts are loading for this filter.';
  }
  if (input.observationsState === 'unavailable') {
    return 'Skill observation facts are unavailable for this filter.';
  }
  if (input.filter === 'to-delete' && input.deletionCandidatesProvisional) {
    return 'Deletion candidates are provisional because the loaded observation history is incomplete.';
  }
  return 'No managed skill matches this filter.';
};

export const worktableEvidenceRank = observationEvidenceRank;
