import { describe, expect, test } from 'bun:test';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { syntheticObservations } from '../shell/synthetic-fixture.test-helper';
import {
  buildSkillObservationsView,
  formatObservedAt,
  NO_OBSERVATIONS_TEXT,
  NOT_OBSERVABLE_TEXT,
  skillObservationRow,
  tallySummary,
} from './model';

const DIGIT_PATTERN = /\d/u;

const view = (managedSkillNames: readonly string[], observations: SkillObservations = syntheticObservations) =>
  buildSkillObservationsView({ managedSkillNames, observations });

describe('skill observations view', () => {
  test('never renders a harness that cannot observe as a zero', () => {
    const built = view(['alpha-skill']);
    const cursorCells = built.rows.flatMap((row) => row.harnesses.filter((cell) => cell.harnessKey === 'cursor'));

    expect(cursorCells).not.toHaveLength(0);
    for (const cell of cursorCells) {
      expect(cell.state).toBe('not-observable');
      expect(cell.summary).toBe(NOT_OBSERVABLE_TEXT);
      expect(cell.tallies).toEqual([]);
      expect(cell.summary).not.toMatch(DIGIT_PATTERN);
    }
  });

  test('states an observable harness with nothing to report as words, not a count', () => {
    const built = view(['alpha-skill']);
    const openCode = skillObservationRow(built, 'alpha-skill')?.harnesses.find(
      (cell) => cell.harnessKey === 'opencode',
    );

    expect(openCode?.state).toBe('no-observations');
    expect(openCode?.summary).toBe(NO_OBSERVATIONS_TEXT);
    // "cannot observe" and "observed nothing" are different sentences, and the surface says both.
    expect(openCode?.summary).not.toBe(NOT_OBSERVABLE_TEXT);
  });

  test('keeps a declared count and an inferred count as two phrases and never one number', () => {
    const built = view(['alpha-skill']);
    const row = skillObservationRow(built, 'alpha-skill');
    const claude = row?.harnesses.find((cell) => cell.harnessKey === 'claude');
    const codex = row?.harnesses.find((cell) => cell.harnessKey === 'codex');

    expect(claude?.summary).toBe('declared 2');
    expect(codex?.summary).toBe('inferred 1');
    // The two tiers are two facts about one skill; 2 + 1 = 3 is not one of them.
    expect(row?.harnesses.map((cell) => cell.summary).join(' ')).not.toContain('3');
    expect(tallySummary([...(claude?.tallies ?? []), ...(codex?.tallies ?? [])])).toBe('declared 2 · inferred 1');
  });

  test('names a managed skill nothing observed as a deletion candidate and keeps it in the table', () => {
    const built = view(['alpha-skill', 'beta-skill']);

    expect(built.deletionCandidates.map(({ skillName }) => skillName)).toEqual(['beta-skill']);
    expect(skillObservationRow(built, 'beta-skill')).toMatchObject({
      lastObservedAt: null,
      managed: true,
      verdict: 'never-observed',
    });
  });

  test('retains an observation that resolves to no inventory entry as an adoption candidate', () => {
    const built = view(['alpha-skill']);

    expect(built.adoptionCandidates.map(({ skillName }) => skillName)).toEqual(['artifact-design']);
    expect(skillObservationRow(built, 'artifact-design')).toMatchObject({
      managed: false,
      resolvedPaths: [],
      verdict: 'unmanaged',
    });
  });

  test('reads honestly at n = 1 and with nothing observed at all', () => {
    const single: SkillObservations = {
      harnesses: syntheticObservations.harnesses,
      lowerBound: false,
      skills: [
        {
          lastObservedAt: '2026-08-01T09:00:00.000Z',
          resolvedPaths: [],
          skillName: 'solo-skill',
          tallies: [
            {
              count: 1,
              harnessKey: 'codex',
              harnessLabel: 'Codex',
              lastObservedAt: '2026-08-01T09:00:00.000Z',
              tier: 'exposed',
            },
          ],
        },
      ],
      skipped: 0,
    };

    expect(skillObservationRow(view([], single), 'solo-skill')?.harnesses.map(({ summary }) => summary)).toEqual([
      NO_OBSERVATIONS_TEXT,
      'exposed 1',
      NO_OBSERVATIONS_TEXT,
      NOT_OBSERVABLE_TEXT,
    ]);

    const empty = view(['alpha-skill'], {
      harnesses: syntheticObservations.harnesses,
      lowerBound: false,
      skills: [],
      skipped: 0,
    });
    expect(empty.rows).toHaveLength(1);
    expect(empty.deletionCandidates.map(({ skillName }) => skillName)).toEqual(['alpha-skill']);
    expect(empty.adoptionCandidates).toEqual([]);
  });

  test('renders an observation instant identically wherever it is rendered', () => {
    // Timezone- and locale-independent by construction, so an SSR paint and its hydration cannot
    // disagree and the string means the same thing to every reader.
    expect(formatObservedAt('2026-08-01T09:07:00.000Z')).toBe('2026-08-01 09:07 UTC');
    expect(formatObservedAt('2026-12-31T23:59:59.999Z')).toBe('2026-12-31 23:59 UTC');
    // A value that is not an instant is shown as it was stored rather than as a fabricated date.
    expect(formatObservedAt('not-a-timestamp')).toBe('not-a-timestamp');
  });

  test('lists managed skills before unmanaged ones and carries the read bound through', () => {
    const built = view(['zeta-skill', 'alpha-skill'], { ...syntheticObservations, lowerBound: true, skipped: 4 });

    expect(built.rows.map(({ skillName }) => skillName)).toEqual(['alpha-skill', 'zeta-skill', 'artifact-design']);
    expect(built.lowerBound).toBe(true);
    expect(built.skipped).toBe(4);
  });
});
