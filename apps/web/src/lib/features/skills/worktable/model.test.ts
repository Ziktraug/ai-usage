import { describe, expect, test } from 'bun:test';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { syntheticManagementSnapshot } from '../management/synthetic-fixture.test-helper';
import { OBSERVATION_ROW_OMITTED_TEXT } from '../observations/model';
import { createSkillsPresentationProjection } from '../presentation';
import { createSkillsShellViewModel } from '../shell/model';
import { skillObservationQueryPresentation } from '../shell/observation-query-presentation';
import {
  syntheticCodexRejectedObservations,
  syntheticExposureTruncatedObservations,
  syntheticInventories,
  syntheticKnownPaths,
  syntheticObservations,
  syntheticProvisionalObservations,
  syntheticSnapshot,
} from '../shell/synthetic-fixture.test-helper';
import {
  createSkillsWorktableModel,
  worktableExposureCaveat,
  worktableHistorySentence,
  worktableManagedEmptyText,
} from './model';

const projection = (
  observations: SkillObservations | undefined,
  observationsError?: string,
  snapshot: unknown = syntheticSnapshot(),
) => {
  const view = createSkillsShellViewModel({
    inventories: syntheticInventories,
    knownProjectPaths: syntheticKnownPaths,
    pathname: '/skills',
    snapshot,
  });
  const presentation = createSkillsPresentationProjection({ observations, observationsError, view });
  return { model: createSkillsWorktableModel({ presentation, view }), presentation };
};

describe('Skills worktable observation presentation', () => {
  test('masks observation-dependent values when a retained Query value has a refetch error', () => {
    const { model, presentation } = projection(syntheticObservations, 'Synthetic background refetch failure.');

    expect(presentation.observations.view).toBeUndefined();
    expect(model.filters.map(({ id, value }) => [id, value])).toEqual([
      ['all', '—'],
      ['to-adopt', '—'],
      ['links-healthy', '0/0'],
      ['to-delete', '—'],
      ['catalogue-only', '—'],
    ]);
    expect(model.managedRows.find((row) => row.name === 'alpha-skill')).toMatchObject({
      lastSignalText: 'observations unavailable',
    });
    expect(model.projectRows.at(0)).toMatchObject({
      lastSignalText: 'observations unavailable',
      summary: 'Skill observations unavailable',
    });
  });

  test('masks retained observation facts while the producer proof is refreshing', () => {
    const queryPresentation = skillObservationQueryPresentation({
      data: syntheticObservations,
      error: null,
      isFetching: true,
      isStale: true,
    });
    const { model, presentation } = projection(queryPresentation.observations, queryPresentation.observationsError);

    expect(presentation.observations.state).toBe('loading');
    expect(model.filters.find((filter) => filter.id === 'all')?.value).toBe('—');
    expect(model.managedRows.find((row) => row.name === 'alpha-skill')?.lastSignalText).toBe('loading observations…');
    expect(model.managedRows.find((row) => row.name === 'alpha-skill')?.cells.flatMap((cell) => cell.evidence)).toEqual(
      [],
    );
  });

  test('marks an expected managed row omitted even when the joined response claims to be exact', () => {
    const { model } = projection(
      {
        ...syntheticObservations,
        invocationLowerBound: false,
        lowerBound: false,
        skills: syntheticObservations.skills.filter((skill) => skill.skillName !== 'beta-skill'),
      },
      undefined,
      syntheticManagementSnapshot(),
    );

    expect(model.managedRows.find((row) => row.name === 'beta-skill')?.lastSignalText).toBe(
      OBSERVATION_ROW_OMITTED_TEXT,
    );
    expect(model.deletionCandidatesProvisional).toBe(true);
    expect(model.filters.find((filter) => filter.id === 'to-delete')).toMatchObject({
      accessibleValue: '0 provisional managed deletion candidates',
      value: '0 provisional',
    });
    expect(
      worktableManagedEmptyText({
        deletionCandidatesProvisional: model.deletionCandidatesProvisional,
        filter: 'to-delete',
        observationsState: 'ready',
      }),
    ).toBe('Deletion candidates are provisional because the loaded observation history is incomplete.');
  });

  test('does not blame omitted rows when bounded invocation history makes deletion candidates provisional', () => {
    const { model } = projection(syntheticProvisionalObservations, undefined, syntheticManagementSnapshot());

    expect(model.deletionCandidatesProvisional).toBe(true);
    expect(
      worktableManagedEmptyText({
        deletionCandidatesProvisional: model.deletionCandidatesProvisional,
        filter: 'to-delete',
        observationsState: 'ready',
      }),
    ).toBe('Deletion candidates are provisional because the loaded observation history is incomplete.');
  });

  test('makes the catalogue provisional when an expected project-owned name is omitted', () => {
    const { model } = projection({
      ...syntheticObservations,
      invocationLowerBound: false,
      lowerBound: false,
      skills: syntheticObservations.skills.filter(
        (skill) => skill.skillName !== 'project-review' && skill.verdict !== 'offered-only',
      ),
    });

    expect(model.filters.find((filter) => filter.id === 'catalogue-only')).toMatchObject({
      accessibleValue: '0 names provisionally classified as offered-only',
      value: '0 provisional',
    });
    expect(model.catalogue).toMatchObject({
      description: expect.stringContaining('classification is provisional'),
      emptyText: 'No catalogue-only row appears in loaded history; classification remains provisional.',
    });
  });

  test('labels bounded dates as retained and explains incompleteness without guessing its cause', () => {
    const exposure = projection(syntheticExposureTruncatedObservations);
    const invocation = projection(syntheticProvisionalObservations);
    const row = exposure.presentation.observations.rowsByName.get('alpha-skill');

    expect(exposure.model.managedRows.find((candidate) => candidate.name === 'alpha-skill')?.lastSignalText).toBe(
      'latest retained 2026-08-02',
    );
    expect(exposure.model.filters.find((filter) => filter.id === 'catalogue-only')?.value).toBe('≥1');
    expect(exposure.model.catalogue.foldSummary).toContain('≥1 skill name');
    expect(exposure.model.catalogue.rollups.at(0)?.entryCountText).toBe('≥1 skill name');
    expect(invocation.model.filters.find((filter) => filter.id === 'all')?.value).toBe('≥4');
    expect(invocation.model.headline).toContain('At least 4 skill names');
    expect(invocation.model.filters.find((filter) => filter.id === 'to-adopt')?.value).toBe('≥0');
    expect(invocation.model.adoption.emptyText).toBe(
      'No runtime-installed adoption candidate appears in loaded history.',
    );
    expect(invocation.model.filters.find((filter) => filter.id === 'to-delete')?.value).toBe('1 provisional');
    expect(invocation.model.filters.find((filter) => filter.id === 'catalogue-only')?.value).toBe('1 provisional');
    expect(invocation.model.filters.find((filter) => filter.id === 'catalogue-only')?.accessibleValue).toBe(
      '1 name provisionally classified as offered-only',
    );
    expect(invocation.model.catalogue.description).toContain('classification is provisional');
    expect(invocation.model.catalogue.foldSummary).toContain('1 provisional skill name');
    expect(invocation.model.catalogue.rollups.at(0)?.entryCountText).toBe('1 provisional skill name');
    expect(invocation.model.projectRows.at(0)).toMatchObject({
      observedCount: 2,
      observedCountLowerBound: true,
      summary: expect.stringContaining('At least 2 with invocation evidence — top retained:'),
    });
    expect(exposure.model.projectRows.at(0)?.summary).toContain('project-review (~4 Codex · 2 OpenCode)');
    expect(worktableHistorySentence(row, exposure.presentation.observations.view)).toContain(
      'Latest retained signal 2026-08-02.',
    );
    expect(
      worktableHistorySentence(
        invocation.presentation.observations.rowsByName.get('alpha-skill'),
        invocation.presentation.observations.view,
      ),
    ).toContain('at least 2 recorded');
    expect(worktableExposureCaveat(exposure.presentation.observations.view)).toBe(
      'Exposure evidence is incomplete, so exposed counts are lower bounds.',
    );
    expect(worktableExposureCaveat(invocation.presentation.observations.view)).toBe(
      'Observation evidence is incomplete, so declared, inferred, and exposed counts are lower bounds.',
    );

    const exposureSilentRow = exposure.presentation.observations.rowsByName.get('beta-skill');
    const invocationSilentRow = invocation.presentation.observations.rowsByName.get('beta-skill');
    expect(worktableHistorySentence(exposureSilentRow, exposure.presentation.observations.view)).toContain(
      'No invocation recorded by any harness that can report.',
    );
    expect(worktableHistorySentence(exposureSilentRow, exposure.presentation.observations.view)).toContain(
      'No signal in loaded history for Claude Code, Codex, OpenCode.',
    );
    expect(worktableHistorySentence(invocationSilentRow, invocation.presentation.observations.view)).toContain(
      'No invocation in loaded history by any harness that can report.',
    );
  });
});

describe('Skills worktable per-harness evidence scoping', () => {
  test('renders a clean harness exactly while its rejected sibling renders a floor', () => {
    const { model, presentation } = projection(syntheticCodexRejectedObservations);
    const alpha = model.managedRows.find((row) => row.name === 'alpha-skill');
    const evidenceByColumn = new Map(
      alpha?.cells.map((cell) => [
        model.columns.find((column) => column.key === cell.columnKey)?.harnessKey,
        cell.evidence,
      ]),
    );

    // Claude Code collected every line it had, so its two declared invocations are a number.
    expect(evidenceByColumn.get('claude')?.map((entry) => entry.text)).toEqual(['2']);
    expect(evidenceByColumn.get('claude')?.at(0)?.accessibleText).toBe('2 recorded invocations in Claude Code');
    // Codex rejected one line, so only Codex's counts are floors.
    expect(evidenceByColumn.get('codex')?.map((entry) => entry.text)).toEqual(['~≥1']);
    expect(evidenceByColumn.get('codex')?.at(0)?.accessibleText).toBe(
      'at least 1 invocation reconstructed from traces in Codex',
    );

    // The cross-harness verdicts are untouched: "invoked in no observable harness" cannot be proved
    // while Codex's invocation evidence is short, whatever Claude Code's numbers are worth.
    expect(model.deletionCandidatesProvisional).toBe(true);
    expect(model.filters.find((filter) => filter.id === 'to-delete')?.value).toBe('1 provisional');
    expect(presentation.observations.view?.invocationLowerBound).toBe(true);
    expect(presentation.observations.view?.invocationEvidenceComplete).toBe(false);
  });

  test('qualifies a per-harness absence phrase by that harness own completeness', () => {
    const { presentation } = projection(syntheticCodexRejectedObservations);
    const sentence = worktableHistorySentence(
      presentation.observations.rowsByName.get('beta-skill'),
      presentation.observations.view,
    );

    expect(sentence).toContain('No signal recorded for Claude Code, OpenCode.');
    expect(sentence).toContain('No signal in loaded history for Codex.');
    // The "any harness that can report" clause is cross-harness and stays global.
    expect(sentence).toContain('No invocation in loaded history by any harness that can report.');
  });
});

const syntheticTarget = (id: string, label: string, enabled = true) => ({
  enabled,
  id,
  kind: 'standard-interop' as const,
  label,
  missing: false,
  observed: true,
  path: `/synthetic/runtime/${id}/skills`,
  scope: 'system' as const,
});

const snapshotWithTargets = (targets: readonly ReturnType<typeof syntheticTarget>[]) => ({
  ...syntheticSnapshot(),
  targets,
});

const evidenceIn = (
  row:
    | {
        readonly cells: readonly {
          readonly columnKey: string;
          readonly evidence: readonly { readonly text: string }[];
        }[];
      }
    | undefined,
  columnKey: string,
) => row?.cells.find((cell) => cell.columnKey === columnKey)?.evidence.map((entry) => entry.text);

describe('Skills worktable placement-target columns', () => {
  test('resolves a declared target id to its harness, without a second column of the same label', () => {
    const { model } = projection(
      syntheticObservations,
      undefined,
      snapshotWithTargets([syntheticTarget('claude-code', 'Claude Code')]),
    );

    expect(model.columns.find((column) => column.key === 'target:claude-code')?.harnessKey).toBe('claude');
    expect(model.columns.filter((column) => column.label === 'Claude Code')).toHaveLength(1);
    expect(
      evidenceIn(
        model.managedRows.find((row) => row.name === 'alpha-skill'),
        'target:claude-code',
      ),
    ).toEqual(['2']);
  });

  test('gives an unrecognised target id no harness even when its label matches one', () => {
    const { model } = projection(
      syntheticObservations,
      undefined,
      snapshotWithTargets([syntheticTarget('team-codex', 'Codex')]),
    );
    const alpha = model.managedRows.find((row) => row.name === 'alpha-skill');

    expect(model.columns.find((column) => column.key === 'target:team-codex')?.harnessKey).toBeUndefined();
    expect(evidenceIn(alpha, 'target:team-codex')).toEqual([]);
    expect(evidenceIn(alpha, 'harness:codex')).toEqual(['~1']);
  });

  test('keeps a column for every observable harness no enabled target claims', () => {
    const { model } = projection(
      syntheticObservations,
      undefined,
      snapshotWithTargets([syntheticTarget('codex', 'Codex'), syntheticTarget('opencode', 'OpenCode', false)]),
    );

    expect(model.columns.map((column) => [column.key, column.harnessKey])).toEqual([
      ['target:codex', 'codex'],
      ['harness:claude', 'claude'],
      ['harness:opencode', 'opencode'],
    ]);
  });
});
