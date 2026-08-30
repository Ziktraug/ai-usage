import { isPrintableSkillObservationText, type SkillObservation } from '@ai-usage/report-core/skill-observation';
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
}

/**
 * Dropping a whole skill row here is not the same kind of clamp as dropping trailing observations.
 *
 * The inventory join runs downstream, and it re-adds every managed skill this dataset does not
 * mention — as a skill with no tallies, which reads as *never observed*. So a managed skill dropped
 * by these clamps comes back wearing a false absence verdict. That makes the skill clamps a
 * truncation of invocation evidence in the only sense that matters to a verdict, and they say so.
 */
const clampSkills = (dataset: SkillObservationDataset, bounds: SkillObservationReadBounds): SkillObservationDataset => {
  let skills: readonly SkillObservationSummary[] = dataset.skills;
  let clampedSkillRows = false;
  if (skills.length > bounds.maximumSkills) {
    skills = skills.slice(0, bounds.maximumSkills);
    clampedSkillRows = true;
  }
  let clamped: SkillObservationDataset = { ...dataset, skills };
  // Byte clamping is a loop rather than one estimate because skill names and resolved paths are
  // open-vocabulary: their serialized size is not derivable from the row count. Halving converges
  // in a handful of passes and always terminates, because an empty skill list is under any budget
  // a harness roster fits in.
  while (clamped.skills.length > 0 && datasetBytes(clamped) > bounds.maximumBytes) {
    clampedSkillRows = true;
    clamped = { ...clamped, skills: clamped.skills.slice(0, Math.floor(clamped.skills.length / 2)) };
  }
  if (!clampedSkillRows) {
    return clamped;
  }
  return {
    ...clamped,
    invocationLowerBound: true,
    lowerBound: true,
  };
};

interface PresentableObservations {
  readonly observations: readonly SkillObservation[];
  /** Rows the presentation edge refused, to be added to the reader's own skipped count. */
  readonly refused: number;
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
  let refused = 0;
  for (const { observation } of rows) {
    if (isPrintableSkillObservationText(observation.skillName)) {
      observations.push(observation);
    } else {
      refused += 1;
    }
  }
  return { observations, refused };
};

export const querySkillObservationDataset = (
  input: QuerySkillObservationDatasetInput,
): Effect.Effect<SkillObservationDataset, UsageStoreError> =>
  Effect.map(
    querySkillObservations({ dbPath: input.dbPath, maximumObservations: input.maximumObservations }),
    (result) => {
      const presentable = presentableObservations(result.observations);
      return clampSkills(
        createSkillObservationDataset(presentable.observations, {
          invocationLowerBound:
            result.invocationTruncated ||
            result.collectionInvocationIncomplete ||
            result.skipped > 0 ||
            presentable.refused > 0,
          lowerBound:
            result.truncated ||
            result.collectionInvocationIncomplete ||
            result.collectionExposureIncomplete ||
            result.skipped > 0 ||
            presentable.refused > 0,
          producerCompletenessMissing: result.producerCompletenessMissing,
          skipped: result.skipped + presentable.refused,
        }),
        input,
      );
    },
  );
