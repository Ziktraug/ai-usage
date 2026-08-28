import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';

/**
 * A skill observation is one record that a named skill was invoked, or offered,
 * in one session of one harness (see `CONTEXT.md`). It is an auxiliary fact
 * family — n-per-session — modelled on `provider_quota_*`, never a column on a
 * usage row.
 *
 * ADR 0022 binds three properties of this shape:
 *
 * - The **tier** is part of the fact. `declared` means the harness recorded the
 *   invocation as such; `inferred` means it was reconstructed from a weaker
 *   trace; `exposed` means the skill was offered with no evidence of use.
 *   Tiers are never silently merged.
 * - **Unresolvable is a state, not a drop.** `resolvedPath` is nullable and a
 *   `null` is meaningful: harness-bundled and plugin skills legitimately
 *   resolve to nothing, and they carry the "invoked but unmanaged" verdict.
 * - **Arguments are never persisted.** Skill arguments are user prose and have
 *   been measured to contain client names and business context. Only their
 *   presence is recorded, as `argsPresent`.
 *
 * The usage store re-validates persisted rows on read, so this parser is
 * deliberately permissive: `skillName` and `harnessKey` are open vocabularies,
 * and the length bounds below exist only to cap read cost. **Never tighten
 * them** — a narrower shape retroactively invalidates history already on disk.
 * Narrow at the presentation edge instead.
 */
export const SKILL_OBSERVATION_TIERS = ['declared', 'inferred', 'exposed'] as const;

export type SkillObservationTier = (typeof SKILL_OBSERVATION_TIERS)[number];

const TIERS: ReadonlySet<string> = new Set(SKILL_OBSERVATION_TIERS);

/** Read-cost ceilings, not a vocabulary. Raising one is safe; lowering one is not. */
export const MAX_SKILL_OBSERVATION_NAME_LENGTH = 512;
export const MAX_SKILL_OBSERVATION_PATH_LENGTH = 2048;
export const MAX_SKILL_OBSERVATIONS_PER_SESSION = 4096;
export const MAX_SKILL_OBSERVATION_BATCH = 100_000;

export interface SkillObservation {
  /**
   * Whether the invocation carried arguments. `null` when the harness does not
   * record arguments at all. The argument *text* is never captured.
   */
  argsPresent: boolean | null;
  harnessKey: string;
  /**
   * A stable, harness-scoped identity for this observation within its session,
   * so a re-scan of unchanged history re-imports idempotently rather than
   * duplicating. Derived from the harness's own call identifier where one
   * exists, and from a record ordinal where none does.
   */
  observationKey: string;
  observedAt: string;
  projectPath: string | null;
  /**
   * The resolved on-disk skill directory, when the harness disclosed one.
   * `null` is a state, not a defect (ADR 0022).
   */
  resolvedPath: string | null;
  sessionId: string;
  skillName: string;
  success: boolean | null;
  tier: SkillObservationTier;
}

/**
 * What an extractor produces. The reject count exists because
 * `parseSkillObservation` returning `null` is otherwise a silent drop: a
 * harness that changed shape would quietly report fewer observations rather
 * than surfacing that the extractor needs fixing.
 */
export interface SkillObservationExtraction {
  observations: SkillObservation[];
  rejected: number;
}

export const isSkillObservationTier = (value: unknown): value is SkillObservationTier =>
  typeof value === 'string' && TIERS.has(value);

/**
 * Whether a harness can report skill observations at all (see `CONTEXT.md`).
 *
 * This exists because an empty observation list is ambiguous on its own:
 * `observed nothing` and `cannot observe` are the same array. ADR 0022 makes
 * observability part of the model precisely so a consumer never has to guess,
 * and so an unobservable harness is never rendered as a `0`.
 */
export type SkillObservability = 'observable' | 'not-observable';

/**
 * The harnesses with a skill-observation collector. Cursor is deliberately
 * absent: its state database contains zero skill tool keys, so it records no
 * usage to collect. Skills are still projected into it — which is exactly why
 * a zero would be a false claim rather than a missing number.
 */
const OBSERVABLE_HARNESSES: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode']);

export const skillObservabilityFor = (harnessKey: string): SkillObservability =>
  OBSERVABLE_HARNESSES.has(harnessKey) ? 'observable' : 'not-observable';

const boundedNonEmpty = (value: unknown, maximumLength: number): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : null;
};

const boundedNullable = (value: unknown, maximumLength: number): { ok: boolean; value: string | null } => {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  const bounded = boundedNonEmpty(value, maximumLength);
  return bounded === null ? { ok: false, value: null } : { ok: true, value: bounded };
};

const nullableBoolean = (value: unknown): { ok: boolean; value: boolean | null } => {
  if (value === null || value === undefined) {
    return { ok: true, value: null };
  }
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false, value: null };
};

const OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  'argsPresent',
  'harnessKey',
  'observationKey',
  'observedAt',
  'projectPath',
  'resolvedPath',
  'sessionId',
  'skillName',
  'success',
  'tier',
]);

/**
 * Strictly structural validation with an open vocabulary for names and paths.
 * Returns `null` for a record this store must refuse to persist; it never
 * repairs, and it never silently drops a field.
 */
export const parseSkillObservation = (value: unknown): SkillObservation | null => {
  if (!(isRecord(value) && Object.keys(value).every((key) => OBSERVATION_KEYS.has(key)))) {
    return null;
  }
  const harnessKey = boundedNonEmpty(value.harnessKey, MAX_SKILL_OBSERVATION_NAME_LENGTH);
  const observationKey = boundedNonEmpty(value.observationKey, MAX_SKILL_OBSERVATION_PATH_LENGTH);
  const sessionId = boundedNonEmpty(value.sessionId, MAX_SKILL_OBSERVATION_NAME_LENGTH);
  const skillName = boundedNonEmpty(value.skillName, MAX_SKILL_OBSERVATION_NAME_LENGTH);
  const observedAt = typeof value.observedAt === 'string' ? normalizeIsoTimestamp(value.observedAt) : null;
  const projectPath = boundedNullable(value.projectPath, MAX_SKILL_OBSERVATION_PATH_LENGTH);
  const resolvedPath = boundedNullable(value.resolvedPath, MAX_SKILL_OBSERVATION_PATH_LENGTH);
  const success = nullableBoolean(value.success);
  const argsPresent = nullableBoolean(value.argsPresent);
  if (
    !(
      harnessKey &&
      observationKey &&
      sessionId &&
      skillName &&
      observedAt &&
      isSkillObservationTier(value.tier) &&
      projectPath.ok &&
      resolvedPath.ok &&
      success.ok &&
      argsPresent.ok
    )
  ) {
    return null;
  }
  return {
    argsPresent: argsPresent.value,
    harnessKey,
    observationKey,
    observedAt,
    projectPath: projectPath.value,
    resolvedPath: resolvedPath.value,
    sessionId,
    skillName,
    success: success.value,
    tier: value.tier,
  };
};

/**
 * The natural key a store uses to make re-import idempotent. Two observations
 * sharing it are the same observation seen twice, not two invocations.
 */
export const skillObservationIdentity = (observation: SkillObservation): string =>
  JSON.stringify([observation.harnessKey, observation.sessionId, observation.tier, observation.observationKey]);
