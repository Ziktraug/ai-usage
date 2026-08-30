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
