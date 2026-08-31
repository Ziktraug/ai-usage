import { isPrintableSkillObservationText, type SkillObservation } from '@ai-usage/report-core/skill-observation';
import {
  applySkillObservationEvidenceLoss,
  resolveSkillObservationEvidence,
  type SkillObservationEvidence,
  type SkillObservationRefusalCounts,
  skillObservationTierSupportsInvocation,
} from '@ai-usage/report-core/skill-observation-evidence';
import {
  createSkillObservationDataset,
  type SkillObservationDataset,
  type SkillObservationSummary,
} from '@ai-usage/report-core/skill-observation-summary';
import { querySkillObservations, type UsageStoreError } from '@ai-usage/usage-store/reader';
import { Effect } from 'effect';

/**
 * The one bounded read of the skill-observation fact family, shared by every consumer that needs
 * the presented dataset (ADR 0022). It is a direct read of durable observations and never names a
 * served report revision, the same shape as `provider-quota-history.ts`.
 *
 * Living here rather than inside a single caller is deliberate: the read and the fold are one
 * operation, and the integration test that traverses collection to presentation must exercise the
 * very same composition the web read model runs, not a copy of it.
 *
 * **Every bound reports itself.** A store can legitimately hold more observations, more distinct
 * skills, or more bytes than a consumer's response budget allows. Refusing to answer in that case
 * would turn a large history into a broken page, and silently returning a short list would present
 * a truncated count as a complete one. So each bound clamps and sets `lowerBound`, which every
 * downstream renderer already treats as "these counts are floors, not numbers".
 */

/** Serialized size of the dataset, measured the way a JSON response is. */
const datasetBytes = (dataset: SkillObservationDataset): number =>
  new TextEncoder().encode(JSON.stringify(dataset)).byteLength;

export interface SkillObservationReadBounds {
  /** Serialized response budget in bytes. */
  readonly maximumBytes: number;
  /**
   * Rows read from the store. Reported one past the bound, so a list that stops exactly at the
   * limit is distinguishable from a complete one.
   */
  readonly maximumObservations: number;
  /** Distinct skills the response may carry. */
  readonly maximumSkills: number;
}

export interface QuerySkillObservationDatasetInput extends SkillObservationReadBounds {
  readonly dbPath: string;
  readonly expectedProducerHarnessKeys?: readonly string[];
  readonly harnessKey?: string;
  readonly incompleteProducerHarnessKeys?: readonly string[];
  readonly machineId?: string;
  readonly minimumProducerCollectedAt?: string;
}

/**
 * Dropping a whole skill row here is not the same kind of clamp as dropping trailing observations.
 *
 * The inventory join runs downstream, and it re-adds every managed skill this dataset does not
 * mention. Losing a row that carried `declared`/`inferred` evidence can therefore create a false
 * invocation-absence verdict; losing an exposure-only row cannot. The discarded rows are still in
 * hand here, so the two loss categories remain separate rather than hedging every absence claim.
 */
const clampSkills = (dataset: SkillObservationDataset, bounds: SkillObservationReadBounds): SkillObservationDataset => {
  const rowsCarryInvocation = (rows: readonly SkillObservationSummary[]): boolean =>
    rows.some((skill) => skill.tallies.some((tally) => skillObservationTierSupportsInvocation(tally.tier)));

  let evidence: SkillObservationEvidence = dataset;
  let skills: readonly SkillObservationSummary[] = dataset.skills;
  if (skills.length > bounds.maximumSkills) {
    evidence = applySkillObservationEvidenceLoss(evidence, {
      counts: true,
      invocation: rowsCarryInvocation(skills.slice(bounds.maximumSkills)),
    });
    skills = skills.slice(0, bounds.maximumSkills);
  }
  let clamped: SkillObservationDataset = { ...dataset, ...evidence, skills };
  // Byte clamping is a loop rather than one estimate because skill names and resolved paths are
  // open-vocabulary: their serialized size is not derivable from the row count. Halving converges
  // in a handful of passes and always terminates, because an empty skill list is under any budget
  // a harness roster fits in.
  while (clamped.skills.length > 0 && datasetBytes(clamped) > bounds.maximumBytes) {
    const retainedCount = Math.floor(clamped.skills.length / 2);
    evidence = applySkillObservationEvidenceLoss(evidence, {
      counts: true,
      invocation: rowsCarryInvocation(clamped.skills.slice(retainedCount)),
    });
    clamped = { ...clamped, ...evidence, skills: clamped.skills.slice(0, retainedCount) };
  }
  return clamped;
};

interface PresentableObservations {
  readonly observations: readonly SkillObservation[];
  /** Rows the presentation edge refused, split by the claim their known tier supported. */
  readonly refusedRows: SkillObservationRefusalCounts;
}

/**
 * The presentation edge's content check, and the reason it is a filter rather than a failure.
 *
 * The store is deliberately permissive about `skillName`: it is an open vocabulary, and tightening
 * the persisted shape later would retroactively invalidate history already on disk (ADR 0022). The
 * response schema is not permissive — it refuses a name carrying control characters, because
 * nothing can render one. Shipping such a row would make the schema reject the entire response, so
 * one malformed persisted row would take the whole observation surface down with it.
 *
 * A refused row is therefore counted into `skipped`, which already means exactly this: "persisted
 * rows the reader could not re-validate, reported and never folded into a count". Every other row
 * still answers, and the count says something was left out.
 */
const presentableObservations = (
  rows: readonly { readonly observation: SkillObservation }[],
): PresentableObservations => {
  const observations: SkillObservation[] = [];
  let refusedExposure = 0;
  let refusedInvocation = 0;
  for (const { observation } of rows) {
    if (isPrintableSkillObservationText(observation.skillName)) {
      observations.push(observation);
    } else if (skillObservationTierSupportsInvocation(observation.tier)) {
      refusedInvocation += 1;
    } else {
      refusedExposure += 1;
    }
  }
  return {
    observations,
    refusedRows: { exposure: refusedExposure, invocation: refusedInvocation, unknown: 0 },
  };
};

export const querySkillObservationDataset = (
  input: QuerySkillObservationDatasetInput,
): Effect.Effect<SkillObservationDataset, UsageStoreError> =>
  Effect.map(
    querySkillObservations({
      dbPath: input.dbPath,
      maximumObservations: input.maximumObservations,
      ...(input.expectedProducerHarnessKeys === undefined
        ? {}
        : { expectedProducerHarnessKeys: input.expectedProducerHarnessKeys }),
      ...(input.harnessKey === undefined ? {} : { harnessKey: input.harnessKey }),
      ...(input.incompleteProducerHarnessKeys === undefined
        ? {}
        : { incompleteProducerHarnessKeys: input.incompleteProducerHarnessKeys }),
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.minimumProducerCollectedAt === undefined
        ? {}
        : { minimumProducerCollectedAt: input.minimumProducerCollectedAt }),
    }),
    (result) => {
      const presentable = presentableObservations(result.observations);
      const evidence = resolveSkillObservationEvidence({
        collection: {
          exposureIncomplete: result.collectionExposureIncomplete,
          invocationIncomplete: result.collectionInvocationIncomplete,
          producerCompletenessMissing: result.producerCompletenessMissing,
        },
        read: {
          invocationTruncated: result.invocationTruncated,
          truncated: result.truncated,
        },
        refusedRows: [result.refusedRows, presentable.refusedRows],
      });
      return clampSkills(
        createSkillObservationDataset(presentable.observations, evidence, result.producerProofValidUntil),
        input,
      );
    },
  );
