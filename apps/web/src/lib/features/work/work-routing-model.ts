import { SUPPORTED_REVIEW_EXECUTOR } from '@ai-usage/report-core/work-attempts';
import { EXECUTOR_HARNESSES, type ExecutorHarness } from '@ai-usage/report-core/work-executors';
import {
  type CandidateIdentity,
  DEFAULT_QUALIFICATION_FRESHNESS,
  type ReviewCandidate,
  type ReviewTarget,
} from '@ai-usage/report-core/work-routing';
import type {
  ExecutorDeclarationWire,
  ExecutorObservationWire,
  WorkRoutingContext,
  WorkRoutingQualification,
} from '@ai-usage/web-contract/work-routing';

/**
 * The short qualification path of the Work view (ADR 0057): per harness, once for the machine
 * rather than once per card, what the engine detected, what the operator declared, whether this
 * session is an authorized target, and what is missing. Every line names its source; a declared
 * value is never worded as an observation.
 */
export interface RoutingSummaryRow {
  readonly declared: readonly string[];
  readonly detected: string;
  readonly execution: string;
  readonly harness: ExecutorHarness;
  readonly identity: readonly string[];
  readonly label: string;
  readonly missing: readonly string[];
  readonly target: string;
}

export const harnessLabel = (harness: ExecutorHarness): string => (harness === 'claude-code' ? 'Claude Code' : 'Codex');
const harnessCommand = (harness: ExecutorHarness): string => (harness === 'claude-code' ? 'claude' : 'codex');

const authLabel = (observation: ExecutorObservationWire): string => {
  if (observation.binaryPath === null || observation.outcome === 'unavailable') {
    return 'not installed or not runnable';
  }
  if (observation.authState === 'logged-in') {
    return `signed in${observation.authMethod ? ` (${observation.authMethod})` : ''}`;
  }
  return observation.authState === 'logged-out' ? 'signed out' : 'sign-in state unknown';
};

const detectedLine = (
  observation: ExecutorObservationWire | undefined,
  harness: ExecutorHarness,
  referenceTime: string,
): string => {
  if (!observation) {
    return `Detected: nothing yet; ${harnessCommand(harness)} has not been observed on this machine.`;
  }
  const age = Date.parse(referenceTime) - Date.parse(observation.observedAt);
  const freshness = age <= DEFAULT_QUALIFICATION_FRESHNESS.executorMs ? 'current' : 'stale';
  const account = observation.accountFingerprint ? `account ${observation.accountFingerprint}` : 'no account reported';
  return `Detected: ${harnessCommand(harness)} ${observation.version ?? '(version unknown)'} · ${authLabel(observation)} · ${account} · observed ${observation.observedAt} (${freshness}).`;
};

const targetsLabel = (declaration: ExecutorDeclarationWire): string =>
  declaration.targets
    .map((target) => (target.kind === 'any-local-session' ? 'any local session' : `project ${target.projectLabel}`))
    .join(', ');

const declaredLine = (declaration: ExecutorDeclarationWire): string => {
  const models = [declaration.model, ...(declaration.alternateModels ?? [])].filter(
    (model): model is string => model !== null,
  );
  return `Declared: account ${declaration.accountScope} · ${declaration.authorization} · subscription ${declaration.subscription} · ${
    models.length > 0 ? `models ${models.join(', ')}` : 'no model declared'
  } · targets ${targetsLabel(declaration)} · ${
    declaration.accountFingerprint ? `pinned to account ${declaration.accountFingerprint}` : 'account not pinned'
  } · declared ${declaration.declaredAt}.`;
};

export const identityLine = (identity: Pick<CandidateIdentity, 'declared' | 'observed' | 'state'>): string => {
  switch (identity.state) {
    case 'confirmed':
      return `Account: the signed-in account (observed ${identity.observed}) is the pinned one.`;
    case 'contradicted':
      return `Account: the CLI is signed in to ${identity.observed} (observed), the declaration pins ${identity.declared}; this route is invalidated until you sign back in or re-declare.`;
    case 'unpinned':
      return `Account: ${identity.observed} is observed, but the declaration pins no account; pin it to bind this route to it.`;
    case 'unobserved':
      return `Account: ${identity.declared} is pinned (declared), but no current observation reports the signed-in account.`;
    default:
      return 'Account: this harness reports no account without its credential file; the quota binding rests on the single declaration.';
  }
};

export interface RoutingSummaryInput {
  readonly candidates: readonly ReviewCandidate[];
  readonly context: WorkRoutingContext;
  readonly referenceTime: string;
  readonly target: ReviewTarget | null;
}

export const routingSummary = (input: RoutingSummaryInput): RoutingSummaryRow[] => {
  const machineId = input.target?.machineId ?? input.context.machineId;
  return EXECUTOR_HARNESSES.map((harness) => {
    const observation = input.context.executorObservations.find(
      (entry) => entry.machineId === machineId && entry.harness === harness,
    );
    const declarations = input.context.declarations.filter(
      (entry) => entry.machineId === machineId && entry.harness === harness,
    );
    const candidates = input.candidates.filter(
      (candidate) => candidate.harness === harness && candidate.machineId === machineId,
    );
    const declared = candidates.filter((candidate) => candidate.provenance.authorization === 'declared');
    const identities = [
      ...new Set(declared.flatMap((candidate) => (candidate.identity ? [identityLine(candidate.identity)] : []))),
    ];
    let target: string;
    if (input.target === null) {
      target = 'Target: no session identity, so no authorization can be bound to it.';
    } else if (declarations.length === 0) {
      target = 'Target: not authorized; nothing is declared for this harness.';
    } else if (declared.some((candidate) => candidate.authorizedTarget !== null)) {
      target = 'Target: this session is authorized by the declared targets.';
    } else {
      target = 'Target: this session is outside the declared targets.';
    }
    return {
      declared:
        declarations.length === 0
          ? ['Declared: nothing; quota and observations alone never authorize.']
          : declarations.map(declaredLine),
      detected: detectedLine(observation, harness, input.referenceTime),
      execution:
        harness === SUPPORTED_REVIEW_EXECUTOR
          ? 'Execution: a real recommendation can launch a read-only review.'
          : 'Execution: simulated only; this version launches no Codex review.',
      harness,
      identity: identities,
      label: harnessLabel(harness),
      missing: [...new Set(candidates.flatMap((candidate) => candidate.qualificationActions))],
      target,
    };
  });
};

const EXECUTOR_OUTCOME_TEXT: Readonly<Record<WorkRoutingQualification['executors']['outcome'], string>> = {
  disabled: 'the executors source is disabled, so the stored observations were used',
  failed: 'the executor observation failed, so the stored observations were used',
  'not-detected': 'no harness CLI was detected on this machine',
  'not-run': 'no engine observed the executors (synthetic runtime)',
  skipped: 'the executor observation was skipped, so the stored observations were used',
  success: 'observed by the engine for this qualification',
  'timed-out': 'the executor observation timed out, so the stored observations were used',
  warning: 'observed by the engine for this qualification, with a warning',
};

/** One sentence on how fresh the engine's decision is; a stale observation is said, never hidden. */
export const qualificationFreshnessText = (qualification: WorkRoutingQualification): string =>
  `Qualified by the engine at ${qualification.qualifiedAt}; executors ${
    qualification.executors.refreshed
      ? EXECUTOR_OUTCOME_TEXT[qualification.executors.outcome]
      : `not refreshed: ${EXECUTOR_OUTCOME_TEXT[qualification.executors.outcome]}`
  }. Declarations were re-read from the home config; quota is the latest stored observation.`;

export const qualificationHeadline = (qualification: WorkRoutingQualification): string => {
  const recommendation = qualification.recommendation;
  const candidate = qualification.candidates.find((entry) => entry.candidateId === recommendation.candidateId);
  const who = candidate
    ? `${harnessLabel(candidate.harness)} · ${candidate.accountScope ?? 'account unknown'} · ${candidate.model ?? 'model not declared'}`
    : null;
  if (recommendation.kind === 'real') {
    return `Real recommendation: ${who ?? 'unknown candidate'}.`;
  }
  if (recommendation.kind === 'conditional') {
    return `Conditional${who ? ` on ${who}` : ''} (missing: ${recommendation.missing ?? 'candidate detail'}); a conditional result never permits a launch.`;
  }
  return 'No eligible candidate: see each candidate’s exclusions and missing facts.';
};
