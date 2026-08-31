import { describe, expect, test } from 'bun:test';
import {
  applySkillObservationEvidenceLoss,
  COMPLETE_SKILL_OBSERVATION_EVIDENCE,
  resolveSkillObservationEvidence,
  SKILL_OBSERVATION_INVOCATION_TIERS,
  SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS,
  type SkillObservationEvidenceFacts,
  skillObservabilityFor,
  skillObservationAbsenceIsProvable,
  skillObservationHarnessInvocationIsComplete,
  skillObservationHarnessSignalsAreComplete,
  skillObservationTierSupportsInvocation,
  skillObservationVerdictIsProvisional,
} from './skill-observation-evidence';

const completeFacts = (): SkillObservationEvidenceFacts => ({
  collection: {
    exposureIncomplete: false,
    invocationIncomplete: false,
    producerCompletenessMissing: false,
  },
  read: { invocationTruncated: false, truncated: false },
  refusedRows: [],
});

describe('skill observation evidence policy', () => {
  test('owns which tiers can support an invocation claim', () => {
    expect(SKILL_OBSERVATION_INVOCATION_TIERS).toEqual(['declared', 'inferred']);
    expect(skillObservationTierSupportsInvocation('declared')).toBe(true);
    expect(skillObservationTierSupportsInvocation('inferred')).toBe(true);
    expect(skillObservationTierSupportsInvocation('exposed')).toBe(false);
  });

  test('keeps Cursor not observable in the canonical harness capability roster', () => {
    expect(SKILL_OBSERVATION_OBSERVABLE_HARNESS_KEYS).toEqual(['claude', 'codex', 'opencode']);
    expect(skillObservabilityFor('claude')).toBe('observable');
    expect(skillObservabilityFor('cursor')).toBe('not-observable');
  });

  test('keeps exposure-only loss separate from invocation evidence', () => {
    const facts = completeFacts();

    const collectionLoss = resolveSkillObservationEvidence({
      ...facts,
      collection: { ...facts.collection, exposureIncomplete: true },
    });
    const readLoss = resolveSkillObservationEvidence({
      ...facts,
      read: { invocationTruncated: false, truncated: true },
    });

    for (const evidence of [collectionLoss, readLoss]) {
      expect(evidence).toEqual({
        harnessIncompleteness: {
          exposure: [],
          exposureUnattributed: true,
          invocation: [],
          invocationUnattributed: false,
        },
        invocationLowerBound: false,
        lowerBound: true,
        producerCompletenessMissing: false,
        skipped: 0,
      });
      expect(skillObservationAbsenceIsProvable(evidence)).toBe(true);
    }
  });

  test('makes missing producer state independently sufficient to weaken absence', () => {
    const facts = completeFacts();

    const evidence = resolveSkillObservationEvidence({
      ...facts,
      collection: { ...facts.collection, producerCompletenessMissing: true },
    });

    expect(evidence).toMatchObject({
      invocationLowerBound: true,
      lowerBound: true,
      producerCompletenessMissing: true,
    });
    expect(skillObservationAbsenceIsProvable(evidence)).toBe(false);
  });

  test('keeps known exposure refusals out of invocation evidence', () => {
    const facts = completeFacts();

    const evidence = resolveSkillObservationEvidence({
      ...facts,
      refusedRows: [{ exposure: 2, invocation: 0, unknown: 0 }],
    });

    expect(evidence).toEqual({
      harnessIncompleteness: {
        exposure: [],
        exposureUnattributed: true,
        invocation: [],
        invocationUnattributed: false,
      },
      invocationLowerBound: false,
      lowerBound: true,
      producerCompletenessMissing: false,
      skipped: 2,
    });
    expect(skillObservationAbsenceIsProvable(evidence)).toBe(true);
  });

  test('aggregates refusal sites and treats unknown tiers conservatively', () => {
    const facts = completeFacts();

    expect(
      resolveSkillObservationEvidence({
        ...facts,
        refusedRows: [
          { exposure: 3, invocation: 0, unknown: 0 },
          { exposure: 0, invocation: 1, unknown: 1 },
        ],
      }),
    ).toEqual({
      harnessIncompleteness: {
        exposure: [],
        exposureUnattributed: true,
        invocation: [],
        invocationUnattributed: true,
      },
      invocationLowerBound: true,
      lowerBound: true,
      producerCompletenessMissing: false,
      skipped: 5,
    });
  });

  test('applies later count and invocation clamps without erasing prior evidence', () => {
    const countLoss = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      invocation: false,
    });
    expect(countLoss).toMatchObject({ invocationLowerBound: false, lowerBound: true });

    const invocationLoss = applySkillObservationEvidenceLoss(countLoss, {
      counts: true,
      invocation: true,
    });
    expect(invocationLoss).toMatchObject({ invocationLowerBound: true, lowerBound: true });
  });

  test('scopes a named collection incompleteness to its own harness', () => {
    const facts = completeFacts();

    const evidence = resolveSkillObservationEvidence({
      ...facts,
      collection: {
        ...facts.collection,
        invocationIncomplete: true,
        invocationIncompleteHarnessKeys: ['codex'],
      },
    });

    expect(skillObservationHarnessInvocationIsComplete(evidence, 'codex')).toBe(false);
    expect(skillObservationHarnessInvocationIsComplete(evidence, 'claude')).toBe(true);
    expect(skillObservationHarnessSignalsAreComplete(evidence, 'claude')).toBe(true);
    // And the cross-harness answer is untouched: an absence still cannot be proved.
    expect(evidence.invocationLowerBound).toBe(true);
    expect(skillObservationAbsenceIsProvable(evidence)).toBe(false);
  });

  test('hedges every harness for a loss no harness can be blamed for', () => {
    const facts = completeFacts();

    const unnamed = resolveSkillObservationEvidence({
      ...facts,
      collection: { ...facts.collection, invocationIncomplete: true },
    });
    const truncated = resolveSkillObservationEvidence({
      ...facts,
      collection: { ...facts.collection, invocationIncomplete: true, invocationIncompleteHarnessKeys: ['codex'] },
      read: { invocationTruncated: true, truncated: true },
    });

    for (const evidence of [unnamed, truncated]) {
      expect(skillObservationHarnessInvocationIsComplete(evidence, 'claude')).toBe(false);
      expect(skillObservationHarnessInvocationIsComplete(evidence, 'codex')).toBe(false);
    }
  });

  test('keeps an exposure-only incompleteness off that harness invocation channel', () => {
    const facts = completeFacts();

    const evidence = resolveSkillObservationEvidence({
      ...facts,
      collection: { ...facts.collection, exposureIncomplete: true, exposureIncompleteHarnessKeys: ['codex'] },
    });

    expect(skillObservationHarnessInvocationIsComplete(evidence, 'codex')).toBe(true);
    expect(skillObservationHarnessSignalsAreComplete(evidence, 'codex')).toBe(false);
    expect(skillObservationHarnessSignalsAreComplete(evidence, 'claude')).toBe(true);
    expect(evidence.invocationLowerBound).toBe(false);
    expect(evidence.lowerBound).toBe(true);
  });

  test('attributes a clamp to the harnesses whose rows it dropped, and fails closed without them', () => {
    const attributed = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      harnessKeys: ['opencode'],
      invocation: true,
    });

    expect(attributed.invocationLowerBound).toBe(true);
    expect(skillObservationHarnessInvocationIsComplete(attributed, 'opencode')).toBe(false);
    expect(skillObservationHarnessInvocationIsComplete(attributed, 'claude')).toBe(true);
    // The conservative reading: every harness in a dropped row is hedged on the degraded channel.
    expect(skillObservationHarnessSignalsAreComplete(attributed, 'opencode')).toBe(false);

    const unattributed = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      invocation: true,
    });

    expect(skillObservationHarnessInvocationIsComplete(unattributed, 'claude')).toBe(false);
  });

  test('answers for an unknown harness key from the unattributed flags alone', () => {
    const scoped = resolveSkillObservationEvidence({
      ...completeFacts(),
      collection: {
        exposureIncomplete: false,
        invocationIncomplete: true,
        invocationIncompleteHarnessKeys: ['codex'],
        producerCompletenessMissing: false,
      },
    });

    // A key no producer roster knows carries no attributed loss, so its own counts stay exact —
    // the same rule every other harness gets, applied to a key this build has never seen.
    expect(skillObservationHarnessInvocationIsComplete(scoped, 'zed')).toBe(true);
    expect(
      skillObservationHarnessInvocationIsComplete(
        applySkillObservationEvidenceLoss(scoped, { counts: true, invocation: true }),
        'zed',
      ),
    ).toBe(false);
  });

  test('makes only absence verdicts provisional', () => {
    const incomplete = applySkillObservationEvidenceLoss(COMPLETE_SKILL_OBSERVATION_EVIDENCE, {
      counts: true,
      invocation: true,
    });

    expect(skillObservationVerdictIsProvisional(incomplete, false)).toBe(true);
    expect(skillObservationVerdictIsProvisional(incomplete, true)).toBe(false);
    expect(skillObservationVerdictIsProvisional(COMPLETE_SKILL_OBSERVATION_EVIDENCE, false)).toBe(false);
  });
});
