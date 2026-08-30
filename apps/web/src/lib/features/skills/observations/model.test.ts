import { describe, expect, test } from 'bun:test';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import {
  syntheticExposureTruncatedObservations,
  syntheticObservations,
  syntheticProvisionalObservations,
} from '../shell/synthetic-fixture.test-helper';
import {
  buildSkillObservationsView,
  compareObservationRows,
  deletionCandidateText,
  formatObservedAt,
  formatObservedDate,
  NO_SIGNALS_RECORDED_TEXT,
  NOT_OBSERVABLE_TEXT,
  observationEvidenceRank,
  observationRecency,
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
    expect(openCode?.summary).toBe(NO_SIGNALS_RECORDED_TEXT);
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
    // `project-review` is a project-local skill: outside the managed source repository, so it
    // carries the adoption verdict for the same reason the harness-bundled one does.
    expect(built.adoptionCandidates.map(({ skillName }) => skillName)).toEqual(['artifact-design', 'project-review']);
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
      'Available to a model; no invocation recorded.',
    );
  });

  test('says when a resolved-path list stopped at its ceiling, and says nothing when it did not', () => {
    // A ceiling that stays silent reads as a complete census of where the skill lives.
    expect(resolvedPathsNote({ resolvedPaths: ['/synthetic/a', '/synthetic/b'], resolvedPathsTruncated: true })).toBe(
      'Showing 2 directories — the name resolved to more than this list carries.',
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

    expect(built.invocationEvidenceComplete).toBe(false);
    // A short read cannot prove a skill went unused, so the copy says what it actually knows.
    expect(verdictText({ verdict: 'never-observed', verdictProvisional: true })).toBe(
      'No invocation in loaded history; invocation history is incomplete.',
    );
    expect(verdictText({ verdict: 'offered-only', verdictProvisional: true })).toBe(
      'Available to a model; no invocation in loaded history.',
    );
    expect(skillObservationRow(built, 'beta-skill')?.verdictProvisional).toBe(true);
    // Positive invocation evidence is not weakened by a short read.
    expect(skillObservationRow(built, 'alpha-skill')?.verdictProvisional).toBe(false);
    expect(verdictText({ verdict: 'invoked', verdictProvisional: false })).toBe(
      'Invocation evidence from at least one harness.',
    );
  });

  test('qualifies the deletion sentence too, since it is the strongest absence claim on the page', () => {
    const built = view(syntheticProvisionalObservations);
    const candidate = built.deletionCandidates[0];

    expect(candidate?.verdictProvisional).toBe(true);
    // Proposing a deletion is the one verdict a maintainer acts on destructively, so a read that
    // could not establish absence must not phrase it as established.
    expect(deletionCandidateText({ verdictProvisional: true })).toBe(
      'Installed in every enabled runtime, with no invocation in loaded history — a provisional deletion candidate.',
    );
    expect(deletionCandidateText({ verdictProvisional: false })).toBe(
      'Installed in every enabled runtime, with no invocation recorded — a deletion candidate.',
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
      invocationLowerBound: false,
      lowerBound: false,
      producerCompletenessMissing: false,
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
          unmanagedResidence: 'external',
          verdict: 'offered-only',
          verdictProvisional: false,
        },
      ],
      skipped: 0,
    };

    expect(skillObservationRow(view(single), 'solo-skill')?.harnesses.map(({ summary }) => summary)).toEqual([
      NO_SIGNALS_RECORDED_TEXT,
      'exposed 1',
      NO_SIGNALS_RECORDED_TEXT,
      NOT_OBSERVABLE_TEXT,
    ]);

    const empty = view({
      harnesses: syntheticObservations.harnesses,
      invocationLowerBound: false,
      lowerBound: false,
      producerCompletenessMissing: false,
      skills: [],
      skipped: 0,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.deletionCandidates).toEqual([]);
    expect(empty.adoptionCandidates).toEqual([]);
    expect(empty.offeredOnly).toEqual([]);
    expect(empty.invocationEvidenceComplete).toBe(true);
  });

  test('ranks the main table by evidence strength, then recency — never alphabetically', () => {
    const built = view();

    // Three rows carry declared evidence; the most recently observed leads. The managed-but-silent
    // `beta-skill` trails the field instead of sitting alphabetically between them.
    expect(built.invocationRows.map(({ skillName }) => skillName)).toEqual([
      'project-review',
      'alpha-skill',
      'artifact-design',
      'beta-skill',
    ]);
    // Exposed-only unmanaged names are not in the main table at all: they live in the rollups.
    expect(built.invocationRows.map(({ skillName }) => skillName)).not.toContain('imagegen');
    expect(observationEvidenceRank({ tallies: [] })).toBe(0);
    const inferredOnly = skillObservationRow(built, 'imagegen');
    expect(inferredOnly === undefined ? -1 : observationEvidenceRank(inferredOnly)).toBe(0);
  });

  test('orders equal-evidence rows by most recent observation', () => {
    const alpha = skillObservationRow(view(), 'alpha-skill');
    const projectReview = skillObservationRow(view(), 'project-review');
    if (alpha === undefined || projectReview === undefined) {
      throw new Error('fixture rows missing');
    }
    // Both carry declared evidence; project-review was seen a day later.
    expect(compareObservationRows(alpha, projectReview)).toBeGreaterThan(0);
    expect(compareObservationRows(projectReview, alpha)).toBeLessThan(0);
  });

  test('lists only observable harnesses as table columns while the roster keeps Cursor', () => {
    const built = view();

    expect(built.observableHarnesses.map(({ harnessKey }) => harnessKey)).toEqual(['claude', 'codex', 'opencode']);
    // The roster still names the harness that cannot report — said once per surface, not per row.
    expect(built.harnesses.map(({ harnessKey }) => harnessKey)).toContain('cursor');
  });

  test('segments the adoption backlog by residence, actionable population first', () => {
    const built = view();

    expect(built.adoptionGroups.map(({ residence }) => residence)).toEqual(['external', 'project-owned']);
    expect(built.adoptionGroups.flatMap(({ rows }) => rows.map(({ skillName }) => skillName))).toEqual([
      'artifact-design',
      'project-review',
    ]);
    // Every adoption candidate lands in exactly one group.
    expect(built.adoptionGroups.flatMap(({ rows }) => rows)).toHaveLength(built.adoptionCandidates.length);
  });

  test('folds exposed-only names into catalogue rollups instead of rows', () => {
    const catalogue: SkillObservations = {
      ...syntheticObservations,
      skills: [
        ...syntheticObservations.skills,
        ...['vercel:swr', 'vercel:auth', 'plugin-management:plugin-management'].map((skillName) => ({
          deletionCandidate: false,
          lastObservedAt: '2026-08-04T09:00:00.000Z',
          managed: false,
          projectedEverywhere: false,
          resolvedPaths: [],
          resolvedPathsTruncated: false,
          skillName,
          tallies: [
            {
              count: skillName === 'vercel:auth' ? 95 : 96,
              harnessKey: 'codex',
              harnessLabel: 'Codex',
              lastObservedAt: '2026-08-04T09:00:00.000Z',
              tier: 'exposed' as const,
            },
          ],
          unmanagedResidence: 'external' as const,
          verdict: 'offered-only' as const,
          verdictProvisional: false,
        })),
      ],
    };

    const built = view(catalogue);
    expect(built.catalogueRollups.map(({ label }) => label)).toEqual([
      'vercel',
      'plugin-management',
      'Standalone entries',
    ]);
    const vercel = built.catalogueRollups.at(0);
    expect(vercel?.rows.map(({ skillName }) => skillName)).toEqual(['vercel:auth', 'vercel:swr']);
    // A spread over one tier, never a sum across tiers.
    expect(vercel?.exposureSummaries).toEqual(['Codex exposed ×95–96']);
    expect(built.catalogueRollups.at(1)?.exposureSummaries).toEqual(['Codex exposed ×96']);
    // The unprefixed `imagegen` folds into the standalone catalogue rather than standing as a row.
    expect(built.catalogueRollups.at(2)?.rows.map(({ skillName }) => skillName)).toEqual(['imagegen']);
  });

  test('buckets recency from whole UTC days so a paint and its hydration agree', () => {
    const now = new Date('2026-08-29T12:00:00.000Z');

    expect(observationRecency('2026-08-28T09:00:00.000Z', now)).toBe('fresh');
    expect(observationRecency('2026-07-20T09:00:00.000Z', now)).toBe('aging');
    expect(observationRecency('2026-02-16T09:00:00.000Z', now)).toBe('stale');
    expect(observationRecency('2026-05-31T00:00:00.000Z', now)).toBe('aging');
    expect(observationRecency('2026-05-30T23:59:59.999Z', now)).toBe('stale');
    expect(observationRecency('not-a-timestamp', now)).toBe('fresh');
    expect(formatObservedDate('2026-08-09T10:43:00.000Z')).toBe('2026-08-09');
    expect(formatObservedDate('not-a-timestamp')).toBe('not-a-timestamp');
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
    const built = view({ ...syntheticObservations, invocationLowerBound: true, lowerBound: true, skipped: 4 });

    expect(built.rows.map(({ skillName }) => skillName)).toEqual([
      'alpha-skill',
      'beta-skill',
      'artifact-design',
      'imagegen',
      'project-review',
    ]);
    expect(built.lowerBound).toBe(true);
    expect(built.skipped).toBe(4);
    expect(built.invocationEvidenceComplete).toBe(false);
  });

  test('carries a missing producer answer as the initial collection state', () => {
    const built = view({
      ...syntheticProvisionalObservations,
      producerCompletenessMissing: true,
    });

    expect(built.producerCompletenessMissing).toBe(true);
    expect(built.invocationEvidenceComplete).toBe(false);
    expect(built.signalsComplete).toBe(false);
  });

  test('a truncated exposure catalogue leaves every verdict standing', () => {
    const built = view(syntheticExposureTruncatedObservations);

    // The condition a real store is permanently in: Codex writes one exposure row per catalogue
    // entry per session, so the catalogue always outruns the budget. Treating that as a reason to
    // hedge every verdict is what made months of real invocation history read as "never invoked" —
    // and the hedge would never come off, because the condition never clears.
    expect(built.lowerBound).toBe(true);
    expect(built.invocationEvidenceComplete).toBe(true);
    expect(built.onlyExposureTruncated).toBe(true);
    for (const row of built.rows) {
      expect(row.verdictProvisional).toBe(false);
    }
  });

  test('separates a truncated catalogue from truncated invocation evidence', () => {
    // Only the second one can make an absence claim unsafe, so only the second one says so.
    expect(view(syntheticProvisionalObservations).onlyExposureTruncated).toBe(false);
    expect(view(syntheticObservations).onlyExposureTruncated).toBe(false);
    // Unreadable rows are unreadable whichever tier they held, so they never count as exposure-only.
    expect(view({ ...syntheticExposureTruncatedObservations, skipped: 2 })).toMatchObject({
      invocationEvidenceComplete: false,
      onlyExposureTruncated: false,
    });
  });
});
