import { describe, expect, test } from 'bun:test';
import { createSkillsPresentationProjection } from './presentation';
import { createSkillsShellViewModel } from './shell/model';
import {
  syntheticInventories,
  syntheticKnownPaths,
  syntheticObservations,
  syntheticSnapshot,
} from './shell/synthetic-fixture.test-helper';

const projectionFor = (pathname: string) => {
  const view = createSkillsShellViewModel({
    inventories: syntheticInventories,
    knownProjectPaths: syntheticKnownPaths,
    pathname,
    snapshot: syntheticSnapshot(),
  });
  return createSkillsPresentationProjection({
    observations: syntheticObservations,
    observationsError: undefined,
    view,
  });
};

describe('Skills presentation projection', () => {
  test('joins the same authoritative observation and inventory facts for global and selected surfaces', () => {
    const presentation = projectionFor('/skills/global/alpha-skill');

    expect(presentation.selected.name).toBe('alpha-skill');
    expect(presentation.selected.observationRow).toBe(presentation.observations.rowsByName.get('alpha-skill'));
    expect(presentation.selected.verdict).toBe('Invocation evidence from at least one harness.');
    expect(presentation.matrix.rows.map((row) => row.name)).toEqual(['alpha-skill']);
    expect(presentation.health).toEqual({
      blockedCount: 0,
      consolidateCopies: 0,
      consolidateCount: 0,
      consolidateSymlinks: 0,
      disabledCount: 0,
      expectedLinkCount: 0,
      healthyLinkCount: 0,
      toLinkCount: 0,
      toRepairCount: 0,
    });
  });

  test('carries project selection evidence and placement through one join', () => {
    const detail = projectionFor('/skills/projects/synthetic-group/project-review');
    expect(detail.selected).toMatchObject({
      installScope: 'project',
      name: 'project-review',
      observedSummary: 'Codex inferred 4 · OpenCode declared 2',
      projectPlacementSummary: ['Standard Agents · owned directory'],
      verdict:
        'Invocation evidence — owned by a project repository, outside the shared source. Adopt it only to make it global.',
    });
    expect(detail.selected.observationRow).toBe(detail.observations.rowsByName.get('project-review'));
  });

  test('keeps a failed observation identity unavailable without inventing absence facts', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global/alpha-skill',
      snapshot: syntheticSnapshot(),
    });
    const presentation = createSkillsPresentationProjection({
      observations: undefined,
      observationsError: 'Synthetic observation failure.',
      view,
    });

    expect(presentation.observations).toMatchObject({
      errorMessage: 'Synthetic observation failure.',
      state: 'unavailable',
      view: undefined,
    });
    expect(presentation.selected.observationRow).toBeUndefined();
    expect(presentation.selected.verdict).toBeUndefined();
    expect(presentation.unmanagedUsageByName).toBeUndefined();
  });

  test('retains positive observation data while making absence claims provisional after a refetch error', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global/alpha-skill',
      snapshot: syntheticSnapshot(),
    });
    const presentation = createSkillsPresentationProjection({
      observations: syntheticObservations,
      observationsError: 'Synthetic background refetch failure.',
      view,
    });

    expect(presentation.observations).toMatchObject({
      errorMessage: 'Synthetic background refetch failure.',
      state: 'ready',
      view: { invocationEvidenceComplete: false, producerProofCurrent: false },
    });
    expect(presentation.observations.rowsByName.size).toBe(syntheticObservations.skills.length);
    expect(presentation.selected).toMatchObject({
      observationRow: { skillName: 'alpha-skill', verdict: 'invoked', verdictProvisional: false },
      observationRowOmitted: false,
      observedSummary: 'Claude Code declared 2 · Codex inferred 1',
      verdict: 'Invocation evidence from at least one harness.',
    });
    expect(presentation.observations.rowsByName.get('beta-skill')?.verdictProvisional).toBe(true);
    expect(presentation.unmanagedUsageByName).toBeDefined();
  });

  test('does not invent an absence verdict when the bounded response omitted the selected skill', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global/alpha-skill',
      snapshot: syntheticSnapshot(),
    });
    const presentation = createSkillsPresentationProjection({
      observations: {
        ...syntheticObservations,
        invocationLowerBound: true,
        lowerBound: true,
        skills: syntheticObservations.skills.filter((skill) => skill.skillName !== 'alpha-skill'),
      },
      observationsError: undefined,
      view,
    });

    expect(presentation.selected).toMatchObject({
      observationRow: undefined,
      observationRowOmitted: true,
      verdict: undefined,
    });
    expect(presentation.observations.omittedSkillNames.has('alpha-skill')).toBe(true);
  });

  test('treats an expected name absent from an exact joined response as omitted', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global/alpha-skill',
      snapshot: syntheticSnapshot(),
    });
    const presentation = createSkillsPresentationProjection({
      observations: {
        ...syntheticObservations,
        invocationLowerBound: false,
        lowerBound: false,
        skills: syntheticObservations.skills.filter((skill) => skill.skillName !== 'alpha-skill'),
      },
      observationsError: undefined,
      view,
    });

    expect(presentation.selected).toMatchObject({
      observationRow: undefined,
      observationRowOmitted: true,
      verdict: undefined,
    });
    expect(presentation.observations.omittedSkillNames.has('alpha-skill')).toBe(true);
  });

  test('projects the server invocation bound without reinterpreting skipped diagnostics', () => {
    const view = createSkillsShellViewModel({
      inventories: syntheticInventories,
      knownProjectPaths: syntheticKnownPaths,
      pathname: '/skills/global',
      snapshot: syntheticSnapshot(),
    });
    const presentation = createSkillsPresentationProjection({
      observations: { ...syntheticObservations, skipped: 3 },
      observationsError: undefined,
      view,
    });

    expect(presentation.observations.view).toMatchObject({
      invocationEvidenceComplete: true,
      signalsComplete: true,
      skipped: 3,
    });
  });
});
