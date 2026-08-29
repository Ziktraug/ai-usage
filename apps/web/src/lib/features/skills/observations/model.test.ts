import { describe, expect, test } from 'bun:test';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import { syntheticObservations, syntheticProvisionalObservations } from '../shell/synthetic-fixture.test-helper';
import {
  buildSkillObservationsView,
  deletionCandidateText,
  formatObservedAt,
  NO_OBSERVATIONS_TEXT,
  NOT_OBSERVABLE_TEXT,
  resolvedPathsNote,
  skillObservationRow,
  tallySummary,
  verdictText,
} from './model';

const DIGIT_PATTERN = /\d/u;

const view = (observations: SkillObservations = syntheticObservations) => buildSkillObservationsView(observations);

describe('skill observations view', () => {
  test('never renders a harness that cannot observe as a zero', () => {
    const built = view();
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
    const openCode = skillObservationRow(view(), 'alpha-skill')?.harnesses.find(
      (cell) => cell.harnessKey === 'opencode',
    );

    expect(openCode?.state).toBe('no-observations');
    expect(openCode?.summary).toBe(NO_OBSERVATIONS_TEXT);
    // "cannot observe" and "observed nothing" are different sentences, and the surface says both.
    expect(openCode?.summary).not.toBe(NOT_OBSERVABLE_TEXT);
  });

  test('keeps a declared count and an inferred count as two phrases and never one number', () => {
    const row = skillObservationRow(view(), 'alpha-skill');
    const claude = row?.harnesses.find((cell) => cell.harnessKey === 'claude');
    const codex = row?.harnesses.find((cell) => cell.harnessKey === 'codex');

    expect(claude?.summary).toBe('declared 2');
    expect(codex?.summary).toBe('inferred 1');
    // The two tiers are two facts about one skill; 2 + 1 = 3 is not one of them.
    expect(row?.harnesses.map((cell) => cell.summary).join(' ')).not.toContain('3');
    expect(tallySummary([...(claude?.tallies ?? []), ...(codex?.tallies ?? [])])).toBe('declared 2 · inferred 1');
  });

  test('groups each server verdict under exactly one heading', () => {
    const built = view();

    expect(built.deletionCandidates.map(({ skillName }) => skillName)).toEqual(['beta-skill']);
    expect(built.adoptionCandidates.map(({ skillName }) => skillName)).toEqual(['artifact-design']);
    expect(built.offeredOnly.map(({ skillName }) => skillName)).toEqual(['imagegen']);

    // No skill is listed twice, so a reader is never asked to reconcile two headings about one row.
    const grouped = [...built.deletionCandidates, ...built.adoptionCandidates, ...built.offeredOnly].map(
      ({ skillName }) => skillName,
    );
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test('a skill that was only offered is never proposed for adoption', () => {
    const built = view();
    const offered = skillObservationRow(built, 'imagegen');

    // A catalogue lists everything a harness has; being in one is evidence of offering, not use.
    expect(offered?.verdict).toBe('offered-only');
    expect(built.adoptionCandidates).not.toContainEqual(offered);
    expect(verdictText({ verdict: 'offered-only', verdictProvisional: false })).toBe(
      'Offered to a model, with no evidence it was ever invoked.',
    );
  });

  test('says when a resolved-path list stopped at its ceiling, and says nothing when it did not', () => {
    // A ceiling that stays silent reads as a complete census of where the skill lives.
    expect(resolvedPathsNote({ resolvedPaths: ['/synthetic/a', '/synthetic/b'], resolvedPathsTruncated: true })).toBe(
      'Showing 2 of more directories this skill resolved to.',
    );
    // The retained set is the smallest paths in sort order, not the newest or the most used, so the
    // sentence claims only that some are shown.
    expect(resolvedPathsNote({ resolvedPaths: ['/synthetic/a'], resolvedPathsTruncated: false })).toBeUndefined();
    expect(skillObservationRow(view(), 'alpha-skill')?.resolvedPathsTruncated).toBe(false);
  });

  test('retains an observation that resolves to no inventory entry', () => {
    expect(skillObservationRow(view(), 'artifact-design')).toMatchObject({
      managed: false,
      resolvedPaths: [],
      resolvedPathsTruncated: false,
      verdict: 'invoked-unmanaged',
    });
  });

  test('qualifies every absence claim when the read could not prove absence', () => {
    const built = view(syntheticProvisionalObservations);

    expect(built.observationsComplete).toBe(false);
    // A short read cannot prove a skill went unused, so the copy says what it actually knows.
    expect(verdictText({ verdict: 'never-observed', verdictProvisional: true })).toBe(
      'No observation within the read bound.',
    );
    expect(verdictText({ verdict: 'offered-only', verdictProvisional: true })).toBe(
      'Offered to a model; no invocation within the read bound.',
    );
    expect(skillObservationRow(built, 'beta-skill')?.verdictProvisional).toBe(true);
    // A positive verdict is not weakened by a short read: seeing an invocation still proves use.
    expect(skillObservationRow(built, 'alpha-skill')?.verdictProvisional).toBe(false);
    expect(verdictText({ verdict: 'invoked', verdictProvisional: false })).toBe('Invoked in at least one harness.');
  });

  test('qualifies the deletion sentence too, since it is the strongest absence claim on the page', () => {
    const built = view(syntheticProvisionalObservations);
    const candidate = built.deletionCandidates[0];

    expect(candidate?.verdictProvisional).toBe(true);
    // Proposing a deletion is the one verdict a maintainer acts on destructively, so a read that
    // could not establish absence must not phrase it as established.
    expect(deletionCandidateText({ verdictProvisional: true })).toBe(
      'Installed in every enabled runtime, with no invocation within the read bound — a provisional deletion candidate.',
    );
    expect(deletionCandidateText({ verdictProvisional: false })).toBe(
      'Installed in every enabled runtime and still never invoked — a deletion candidate.',
    );
    // The rule the verdict is computed with is the rule both sentences state: a disabled target is
    // not a runtime the skill was expected to be in.
    for (const provisional of [true, false]) {
      expect(deletionCandidateText({ verdictProvisional: provisional })).toContain('every enabled runtime');
    }
  });

  test('reads honestly at n = 1 and with nothing observed at all', () => {
    const single: SkillObservations = {
      harnesses: syntheticObservations.harnesses,
      lowerBound: false,
      skills: [
        {
          deletionCandidate: false,
          lastObservedAt: '2026-08-01T09:00:00.000Z',
          managed: false,
          projectedEverywhere: false,
          resolvedPaths: [],
          resolvedPathsTruncated: false,
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
          verdict: 'offered-only',
          verdictProvisional: false,
        },
      ],
      skipped: 0,
    };

    expect(skillObservationRow(view(single), 'solo-skill')?.harnesses.map(({ summary }) => summary)).toEqual([
      NO_OBSERVATIONS_TEXT,
      'exposed 1',
      NO_OBSERVATIONS_TEXT,
      NOT_OBSERVABLE_TEXT,
    ]);

    const empty = view({ harnesses: syntheticObservations.harnesses, lowerBound: false, skills: [], skipped: 0 });
    expect(empty.rows).toEqual([]);
    expect(empty.deletionCandidates).toEqual([]);
    expect(empty.adoptionCandidates).toEqual([]);
    expect(empty.offeredOnly).toEqual([]);
    expect(empty.observationsComplete).toBe(true);
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
    const built = view({ ...syntheticObservations, lowerBound: true, skipped: 4 });

    expect(built.rows.map(({ skillName }) => skillName)).toEqual([
      'alpha-skill',
      'beta-skill',
      'artifact-design',
      'imagegen',
    ]);
    expect(built.lowerBound).toBe(true);
    expect(built.skipped).toBe(4);
    expect(built.observationsComplete).toBe(false);
  });
});
