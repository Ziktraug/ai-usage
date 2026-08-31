import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';
import { isSkillObservationTier, type SkillObservationTier } from './skill-observation-evidence';

export {
  isSkillObservationTier,
  SKILL_OBSERVATION_TIERS,
  type SkillObservability,
  type SkillObservationTier,
  skillObservabilityFor,
} from './skill-observation-evidence';

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
/** Read-cost ceilings, not a vocabulary. Raising one is safe; lowering one is not. */
export const MAX_SKILL_OBSERVATION_NAME_LENGTH = 512;
/**
 * `PATH_MAX` on Linux and comfortably above macOS's limit, so no path a
 * filesystem can actually hold is rejected by this bound. That matters more
 * than the byte saving: a real path refused here would be stored as
 * `resolvedPath: null`, which is the reserved state for a skill that resolves
 * to nothing — recording a resolvable skill as unresolvable.
 */
export const MAX_SKILL_OBSERVATION_PATH_LENGTH = 4096;
export const MAX_SKILL_OBSERVATIONS_PER_SESSION = 4096;
export const MAX_SKILL_OBSERVATION_BATCH = 100_000;
/**
 * Retention window for catalogue exposure. Declared and inferred invocations
 * remain durable. Collection sources can rescan older transcripts on every
 * sweep, so the same exposure cutoff is applied before import; otherwise
 * startup retention would be undone by the next run.
 */
export const SKILL_OBSERVATION_EXPOSURE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

export interface SkillObservationCompletenessPart {
  /** Candidates that looked like observations but failed validation. */
  rejected: number;
  /** A producer-side bound or partial read stopped before every candidate was inspected. */
  truncated: boolean;
}

/**
 * Completeness of one observable harness sweep, split by the claim it can
 * support. Exposure may be incomplete without weakening an invocation-absence
 * verdict; invocation evidence may not.
 */
export interface SkillObservationCollectionCompleteness {
  exposure: SkillObservationCompletenessPart;
  invocation: SkillObservationCompletenessPart;
}

export const completeSkillObservationCollection = (): SkillObservationCollectionCompleteness => ({
  exposure: { rejected: 0, truncated: false },
  invocation: { rejected: 0, truncated: false },
});

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
  /**
   * Whether the per-session ceiling cut the list short. Like every other
   * bounded read in this product, hitting the bound is reported rather than
   * silently returning a smaller number as if it were complete.
   */
  truncated: boolean;
}

const LAST_C0_CONTROL_CODE_POINT = 0x1f;
const FIRST_C1_CONTROL_CODE_POINT = 0x7f;
const LAST_C1_CONTROL_CODE_POINT = 0x9f;

/**
 * Whether a string is renderable as text.
 *
 * This is the *presentation* rule, and it lives here so there is exactly one of
 * it. The parser above deliberately does not apply it: the store is permissive
 * because tightening it later would retroactively invalidate history already on
 * disk. The presentation edge is where an unrenderable name is refused, and it
 * must refuse only that name — a single control character in one persisted row
 * must never cost the caller the whole response.
 *
 * Checked by code point rather than a regex, because a character-class range
 * over the control block is itself disallowed by this repository's lint rules.
 */
export const isPrintableSkillObservationText = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= LAST_C0_CONTROL_CODE_POINT ||
      (codePoint >= FIRST_C1_CONTROL_CODE_POINT && codePoint <= LAST_C1_CONTROL_CODE_POINT)
    ) {
      return false;
    }
  }
  return true;
};

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
