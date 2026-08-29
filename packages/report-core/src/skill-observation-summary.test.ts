import { describe, expect, test } from 'bun:test';
import type { SkillObservation } from './skill-observation';
import { createSkillObservationDataset, EMPTY_SKILL_OBSERVATION_DATASET } from './skill-observation-summary';

const observation = (overrides: Partial<SkillObservation> & Pick<SkillObservation, 'harnessKey' | 'tier'>) => ({
  argsPresent: null,
  observationKey: `${overrides.harnessKey}-${overrides.tier}-${overrides.observedAt ?? '1'}`,
  observedAt: '2026-08-01T09:00:00.000Z',
  projectPath: '/home/alex/Projects/report',
  resolvedPath: null,
  sessionId: 'session-1',
  skillName: 'improve',
  success: null,
  ...overrides,
});

describe('createSkillObservationDataset', () => {
  test('keeps a declared count and an inferred count as two separate numbers', () => {
    const dataset = createSkillObservationDataset([
      observation({ harnessKey: 'claude', observationKey: 'a', tier: 'declared' }),
      observation({ harnessKey: 'claude', observationKey: 'b', tier: 'declared' }),
      observation({ harnessKey: 'codex', observationKey: 'c', tier: 'inferred' }),
    ]);

    const [skill] = dataset.skills;
    expect(skill?.skillName).toBe('improve');
    expect(skill?.tallies).toEqual([
      {
        count: 2,
        harnessKey: 'claude',
        harnessLabel: 'Claude Code',
        lastObservedAt: '2026-08-01T09:00:00.000Z',
        tier: 'declared',
      },
      {
        count: 1,
        harnessKey: 'codex',
        harnessLabel: 'Codex',
        lastObservedAt: '2026-08-01T09:00:00.000Z',
        tier: 'inferred',
      },
    ]);
    // There is nowhere in the shape to put a 3: no per-skill total and no
    // per-harness total exists to sum the two tiers into.
    expect(JSON.stringify(skill)).not.toContain('"total"');
  });

  test('keeps the Codex exposed and inferred streams apart for one skill', () => {
    const dataset = createSkillObservationDataset([
      observation({ harnessKey: 'codex', observationKey: 'exposed-1', skillName: 'pr-review', tier: 'exposed' }),
      observation({ harnessKey: 'codex', observationKey: 'inferred-1', skillName: 'pr-review', tier: 'inferred' }),
    ]);

    expect(dataset.skills[0]?.tallies.map(({ count, tier }) => ({ count, tier }))).toEqual([
      { count: 1, tier: 'inferred' },
      { count: 1, tier: 'exposed' },
    ]);
  });

  test('enumerates Cursor as not observable even when nothing was observed anywhere', () => {
    expect(EMPTY_SKILL_OBSERVATION_DATASET.skills).toEqual([]);
    expect(EMPTY_SKILL_OBSERVATION_DATASET.harnesses).toEqual([
      { harnessKey: 'claude', label: 'Claude Code', observability: 'observable' },
      { harnessKey: 'codex', label: 'Codex', observability: 'observable' },
      { harnessKey: 'opencode', label: 'OpenCode', observability: 'observable' },
      { harnessKey: 'cursor', label: 'Cursor', observability: 'not-observable' },
    ]);
  });

  test('an unresolved skill keeps its observation and reports no resolved path', () => {
    const dataset = createSkillObservationDataset([
      observation({ harnessKey: 'claude', skillName: 'artifact-design', tier: 'declared' }),
      observation({
        harnessKey: 'claude',
        observationKey: 'resolved',
        resolvedPath: '/home/alex/.agents/skills/improve',
        tier: 'declared',
      }),
    ]);

    expect(
      dataset.skills.map(({ resolvedPaths, resolvedPathsTruncated, skillName }) => ({
        resolvedPaths,
        resolvedPathsTruncated,
        skillName,
      })),
    ).toEqual([
      { resolvedPaths: [], resolvedPathsTruncated: false, skillName: 'artifact-design' },
      {
        resolvedPaths: ['/home/alex/.agents/skills/improve'],
        resolvedPathsTruncated: false,
        skillName: 'improve',
      },
    ]);
  });

  test('a resolved-path list that fits reports itself as complete', () => {
    const dataset = createSkillObservationDataset(
      Array.from({ length: 8 }, (_value, index) =>
        observation({
          harnessKey: 'claude',
          observationKey: `path-${index}`,
          resolvedPath: `/home/alex/.claude/skills/improve-${index}`,
          tier: 'declared',
        }),
      ),
    );

    // Exactly at the ceiling and nothing was dropped, so the list is the whole answer.
    expect(dataset.skills[0]?.resolvedPaths).toHaveLength(8);
    expect(dataset.skills[0]?.resolvedPathsTruncated).toBe(false);
  });

  test('a resolved-path list that hit its ceiling says so', () => {
    const dataset = createSkillObservationDataset(
      Array.from({ length: 9 }, (_value, index) =>
        observation({
          harnessKey: 'claude',
          observationKey: `path-${index}`,
          resolvedPath: `/home/alex/.claude/skills/improve-${index}`,
          tier: 'declared',
        }),
      ),
    );

    // Every bound in this family reports itself (ADR 0022). A list that silently stops at eight
    // reads as "these are all of them", which is a claim the fold never made.
    expect(dataset.skills[0]?.resolvedPaths).toHaveLength(8);
    expect(dataset.skills[0]?.resolvedPathsTruncated).toBe(true);
  });

  test('re-seeing a path already retained is not a truncation', () => {
    const dataset = createSkillObservationDataset(
      Array.from({ length: 40 }, (_value, index) =>
        observation({
          harnessKey: 'claude',
          observationKey: `repeat-${index}`,
          resolvedPath: '/home/alex/.claude/skills/improve',
          tier: 'declared',
        }),
      ),
    );

    expect(dataset.skills[0]?.resolvedPaths).toEqual(['/home/alex/.claude/skills/improve']);
    expect(dataset.skills[0]?.resolvedPathsTruncated).toBe(false);
  });

  test('carries the read bound and the re-validation skip count through untouched', () => {
    const dataset = createSkillObservationDataset([observation({ harnessKey: 'opencode', tier: 'declared' })], {
      lowerBound: true,
      skipped: 3,
    });

    expect(dataset.lowerBound).toBe(true);
    expect(dataset.skipped).toBe(3);
  });

  test('reports the latest observation per tally and per skill', () => {
    const dataset = createSkillObservationDataset([
      observation({
        harnessKey: 'claude',
        observationKey: 'old',
        observedAt: '2026-08-01T09:00:00.000Z',
        tier: 'declared',
      }),
      observation({
        harnessKey: 'claude',
        observationKey: 'new',
        observedAt: '2026-08-04T09:00:00.000Z',
        tier: 'declared',
      }),
      observation({
        harnessKey: 'opencode',
        observationKey: 'oc',
        observedAt: '2026-08-02T09:00:00.000Z',
        tier: 'declared',
      }),
    ]);

    expect(dataset.skills[0]?.lastObservedAt).toBe('2026-08-04T09:00:00.000Z');
    expect(dataset.skills[0]?.tallies.map(({ harnessKey, lastObservedAt }) => [harnessKey, lastObservedAt])).toEqual([
      ['claude', '2026-08-04T09:00:00.000Z'],
      ['opencode', '2026-08-02T09:00:00.000Z'],
    ]);
  });

  test('is order independent', () => {
    const records = [
      observation({ harnessKey: 'codex', observationKey: 'x', skillName: 'zeta', tier: 'exposed' }),
      observation({ harnessKey: 'claude', observationKey: 'y', skillName: 'alpha', tier: 'declared' }),
      observation({ harnessKey: 'opencode', observationKey: 'z', skillName: 'alpha', tier: 'declared' }),
    ];

    expect(createSkillObservationDataset(records)).toEqual(createSkillObservationDataset([...records].reverse()));
  });

  test('is order independent past the resolved-path bound, where a first-n rule would not be', () => {
    // Nine distinct paths against a ceiling of eight. "Keep the first eight" would retain
    // `path-0…path-7` forwards and `path-1…path-8` backwards, so the same store would render two
    // different path lists depending only on how the reader happened to return the rows.
    const records = Array.from({ length: 9 }, (_value, index) =>
      observation({
        harnessKey: 'claude',
        observationKey: `path-${index}`,
        resolvedPath: `/home/alex/.claude/skills/improve-${index}`,
        tier: 'declared',
      }),
    );

    const forward = createSkillObservationDataset(records);
    expect(forward).toEqual(createSkillObservationDataset([...records].reverse()));
    expect(forward.skills[0]?.resolvedPathsTruncated).toBe(true);
    expect(forward.skills[0]?.resolvedPaths).toEqual([
      '/home/alex/.claude/skills/improve-0',
      '/home/alex/.claude/skills/improve-1',
      '/home/alex/.claude/skills/improve-2',
      '/home/alex/.claude/skills/improve-3',
      '/home/alex/.claude/skills/improve-4',
      '/home/alex/.claude/skills/improve-5',
      '/home/alex/.claude/skills/improve-6',
      '/home/alex/.claude/skills/improve-7',
    ]);
  });

  test('an unknown harness key that produced observations is observable, so its tallies survive', () => {
    const dataset = createSkillObservationDataset([observation({ harnessKey: 'future-harness', tier: 'declared' })]);

    // Marking it `not-observable` would assert the opposite of the evidence in hand, and would make
    // the renderer suppress real stored history under a harness that demonstrably observed.
    expect(dataset.harnesses.at(-1)).toEqual({
      harnessKey: 'future-harness',
      label: 'future-harness',
      observability: 'observable',
    });
    expect(dataset.skills[0]?.tallies).toEqual([
      {
        count: 1,
        harnessKey: 'future-harness',
        harnessLabel: 'future-harness',
        lastObservedAt: '2026-08-01T09:00:00.000Z',
        tier: 'declared',
      },
    ]);
  });

  test('a catalogued harness keeps its own marker regardless of what a sweep returned', () => {
    // Cursor cannot observe even in a dataset full of observations; Codex stays observable in one
    // that holds none of its own. The marker is a property of the harness, not of the run.
    const dataset = createSkillObservationDataset([observation({ harnessKey: 'claude', tier: 'declared' })]);
    const marker = (harnessKey: string) =>
      dataset.harnesses.find((harness) => harness.harnessKey === harnessKey)?.observability;

    expect(marker('claude')).toBe('observable');
    expect(marker('codex')).toBe('observable');
    expect(marker('cursor')).toBe('not-observable');
  });
});
