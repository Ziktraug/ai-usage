import path from 'node:path';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import {
  WORK_ATTENTION_BOUNDS,
  type WorkAttentionCoverage,
  type WorkAttentionDataset,
  type WorkFact,
  type WorkFactKind,
  type WorkFactProvenance,
  type WorkInterpretation,
  type WorkInterpretationKind,
  type WorkRoot,
  type WorkRootAge,
  type WorkRootDeclaration,
  type WorkRootProject,
  type WorkSessionKey,
} from '@ai-usage/report-core/work-attention';
import { UsageStoreError, usageStoreErrorReasonFrom } from '@ai-usage/usage-store/reader';
import { Effect, Result } from 'effect';
import { queryWorkAttention } from './work-attention-read';

/**
 * Work context (ADR 0058): the bounded, read-only answer a harness session gets to "what exists,
 * what was decided, what is waiting" for the checkout or project it works in. It is a projection
 * of the one Work attention read (`queryWorkAttention`, ADR 0050/0056), never a second read model:
 * roots, declarations, facts and interpretations are the dataset's own, selected by scope and cut
 * to a tool-response size. The CLI (`ai-usage work context`) and the local MCP tool
 * (`work.context`) both call `readWorkContext`, so both edges answer with the same shape and bounds.
 *
 * It copies less than the dataset exposes, never more: a declaration's question and detail, the
 * interpretations' own sentences, and the linked pull request, checkout and Jira facts. Turn
 * reports, wrap-ups, side-session notes and proposals are cited by id and date only.
 */

export const WORK_CONTEXT_SCHEMA_VERSION = 1 as const;

export const WORK_CONTEXT_BOUNDS = {
  maxCheckouts: 10,
  maxDecisions: 20,
  maxEvidencePerReading: 8,
  maxJiraIssues: 10,
  /** Ceiling of the compact JSON encoding; lists are cut from the least to the most urgent to fit. */
  maxOutputBytes: 64 * 1024,
  maxProjectLabel: WORK_ATTENTION_BOUNDS.maxShortText,
  maxPullRequests: 20,
  maxReadingsPerWait: 4,
  maxRootsPerLinkedFact: 5,
  maxWaits: 20,
} as const;

/** The interpretations that name a dated, explicit native record that a request stopped waiting (ADR 0056). */
export const WORK_CONTEXT_DECISION_KINDS = [
  'request-answered',
  'request-handled-elsewhere',
  'request-archived',
  'earlier-request-answered',
  'earlier-request-superseded',
] as const satisfies readonly WorkInterpretationKind[];
export type WorkContextDecisionKind = (typeof WORK_CONTEXT_DECISION_KINDS)[number];

/** What the context does not cover, stated with every answer so a consumer never reads absence as "nothing". */
export const WORK_CONTEXT_COVERAGE_NOTES = [
  {
    code: 'claude-desktop-only',
    text: 'Only Claude Desktop sessions are represented. Claude Code sessions started outside Claude Desktop, and Codex, OpenCode and Cursor sessions, are not.',
  },
  {
    code: 'declarations-not-transcripts',
    text: 'A declaration is what a session stated at its last turn end, as the Claude Desktop registry recorded it, dated by the session; no transcript is read.',
  },
  {
    code: 'declared-links-only',
    text: 'Pull request, checkout and Jira facts appear only when a session of the family declared the pull request, wrote the Jira key in a branch name, or worked in the checkout.',
  },
  {
    code: 'activity-window',
    text: 'Roots with nothing pending and no activity within coverage.attention.window.sinceDays are left out; a request or an external wait is kept at any age.',
  },
  {
    code: 'literal-paths',
    text: 'Checkout paths are compared as written: symbolic links and git worktrees outside the checkout path are not resolved, and a recorded path that is not absolute is never compared (coverage.roots.unscopedPaths counts them).',
  },
] as const;

/**
 * Replaces the `claude-desktop-only` note when the read included Codex campaigns (ADR 0059): their
 * sessions are in the context, as sessions only.
 */
export const WORK_CONTEXT_CODEX_NOTE = {
  code: 'desktop-waits-codex-sessions',
  text: 'Claude Desktop sessions carry their declared waits. Codex sessions are included as sessions only: Codex declares no wait, so none is derived and none appears in waiting (coverage.harnesses.codex counts the recent campaigns read). Claude Code sessions started outside Claude Desktop, and OpenCode and Cursor sessions, are not represented.',
} as const;

export type WorkContextCoverageNote = (typeof WORK_CONTEXT_COVERAGE_NOTES)[number] | typeof WORK_CONTEXT_CODEX_NOTE;

/** What each harness contributes to the context: declared waits, or sessions only. */
export interface WorkContextHarnessCoverage {
  readonly claudeDesktop: { readonly inScope: number; readonly reads: 'declared-waits' };
  readonly codex: {
    /** Recent served Codex campaigns active in the window, and how many the Work read took (ADR 0059). */
    readonly campaignsInWindow: number;
    readonly campaignsRead: number;
    /**
     * Campaigns read that the page limit cut before the scope was applied (Desktop roots rank
     * first): whether they are in scope is unknown, so `inScope` is a lower bound when this is > 0.
     */
    readonly cutByPage: number;
    readonly inScope: number;
    readonly reads: 'sessions-only';
  };
}

export type WorkContextScope =
  | { readonly checkoutPath: string; readonly kind: 'checkout' }
  | { readonly kind: 'project-label'; readonly projectLabel: string };

/** The scope as applied: a checkout matches roots in that path or inside it, a label matches exactly. */
export type WorkContextAppliedScope =
  | { readonly checkoutPath: string; readonly kind: 'checkout'; readonly match: 'same-or-inside' }
  | { readonly kind: 'project-label'; readonly match: 'exact'; readonly projectLabel: string };

export interface WorkContextRootReference {
  readonly archived: boolean;
  readonly desktopSessionId: string | null;
  readonly key: WorkSessionKey;
  readonly project: WorkRootProject;
  readonly title: string;
}

/** One fact an interpretation rests on, by reference: its kind, its own date and its provenance. */
export interface WorkContextEvidence {
  /** The date the fact itself carries (a declaration's `declaredAt`, a report's `at`, …); `null` when it has none. */
  readonly at: CanonicalInstant | null;
  readonly id: string;
  /** `null` when the dataset's fact bound left the fact out: the reference stays, so the gap is visible. */
  readonly kind: WorkFactKind | null;
  readonly provenance: WorkFactProvenance | null;
}

/** An interpretation of the dataset with its evidence resolved; the text is the read model's own sentence. */
export interface WorkContextReading {
  readonly evidence: readonly WorkContextEvidence[];
  readonly evidenceOmitted: number;
  readonly kind: WorkInterpretationKind;
  readonly text: string;
  readonly uncertainty: string;
}

/** A root whose attention is a human request or an external wait. */
export interface WorkContextWait {
  readonly age: WorkRootAge;
  readonly attention: 'external-wait' | 'human-request';
  /** The Session's own last-turn declaration, dated by it; never its current state. */
  readonly declared: WorkRootDeclaration | null;
  /** Where the declaration was read: the Claude Desktop registry file, its modification time and machine. */
  readonly declaredProvenance: WorkFactProvenance | null;
  /** The interpretations that are not settled decisions, in the dataset's order (the request's own first). */
  readonly readings: readonly WorkContextReading[];
  readonly readingsOmitted: number;
  /** An older declaration to reconsider (ADR 0056): something later may have answered it, unproven. */
  readonly reconsidered: boolean;
  readonly root: WorkContextRootReference;
}

export interface WorkContextDecision extends WorkContextReading {
  readonly kind: WorkContextDecisionKind;
  readonly root: WorkContextRootReference;
}

export interface WorkContextLinkedFact<Kind extends WorkFactKind> {
  readonly fact: Extract<WorkFact, { readonly kind: Kind }>;
  /** The roots in scope that carry the fact, by desktop session id, in the dataset's rank order. */
  readonly roots: readonly string[];
}

export interface WorkContextLinked {
  readonly checkouts: readonly WorkContextLinkedFact<'checkout-status'>[];
  readonly jiraIssues: readonly WorkContextLinkedFact<'jira-issue'>[];
  readonly pullRequests: readonly WorkContextLinkedFact<'declared-pull-request' | 'pull-request'>[];
}

export interface WorkContextOmitted {
  readonly checkouts: number;
  readonly decisions: number;
  readonly jiraIssues: number;
  readonly pullRequests: number;
  readonly waits: number;
}

export interface WorkContextTruncation {
  /** Items were dropped to keep the encoding within `WORK_CONTEXT_BOUNDS.maxOutputBytes`. */
  readonly bytes: boolean;
  /** The Work attention read was itself a selection (a store or page bound): roots in scope may be missing. */
  readonly dataset: boolean;
  /** Items in scope beyond the count bounds or dropped for bytes, per list. */
  readonly omitted: WorkContextOmitted;
}

export interface WorkContextCoverage {
  /** The Work attention read's own coverage, unchanged: what it read, which producers ran, which window it applied. */
  readonly attention: WorkAttentionCoverage;
  /** Per harness, what was read and how many roots of each are in scope. */
  readonly harnesses: WorkContextHarnessCoverage;
  readonly notes: readonly WorkContextCoverageNote[];
  readonly roots: {
    /** Roots of the read that matched the scope. */
    readonly inScope: number;
    /** Roots the read returned, before the scope. */
    readonly read: number;
    /** Every root of the read, including those its window or page left out. */
    readonly total: number;
    /**
     * Roots read whose recorded checkout path is not absolute (relative, or another platform's):
     * never compared with a checkout scope, so never in it; 0 for a project-label scope.
     */
    readonly unscopedPaths: number;
  };
}

export interface WorkContextDataset {
  readonly coverage: WorkContextCoverage;
  readonly decisions: readonly WorkContextDecision[];
  readonly generatedAt: CanonicalInstant;
  readonly linked: WorkContextLinked;
  readonly schemaVersion: typeof WORK_CONTEXT_SCHEMA_VERSION;
  readonly scope: WorkContextAppliedScope;
  /** Any list was cut, for count or bytes, or the underlying read was a selection. */
  readonly truncated: boolean;
  readonly truncation: WorkContextTruncation;
  readonly waiting: readonly WorkContextWait[];
}

export const WORK_CONTEXT_FAILURE_CODES = [
  'cancelled',
  'incompatible-store',
  'invalid-input',
  'store-missing',
  'store-not-upgraded',
  'unavailable',
] as const;
export type WorkContextFailureCode = (typeof WORK_CONTEXT_FAILURE_CODES)[number];

/** A typed failure whose message never carries a path or a store detail. */
export interface WorkContextFailure {
  readonly code: WorkContextFailureCode;
  readonly message: string;
}

export type WorkContextReadResult =
  | { readonly kind: 'error'; readonly failure: WorkContextFailure }
  | { readonly kind: 'success'; readonly value: WorkContextDataset };

const DECISION_KINDS: ReadonlySet<WorkInterpretationKind> = new Set(WORK_CONTEXT_DECISION_KINDS);
const isDecisionKind = (kind: WorkInterpretationKind): kind is WorkContextDecisionKind => DECISION_KINDS.has(kind);
const isWaitingAttention = (attention: WorkRoot['attention']): attention is WorkContextWait['attention'] =>
  attention === 'human-request' || attention === 'external-wait';

/** Validates and normalizes a scope; returns the problem as a path-free sentence when it is not usable. */
export const normalizeWorkContextScope = (scope: WorkContextScope): WorkContextAppliedScope | string => {
  if (scope.kind === 'checkout') {
    const { checkoutPath } = scope;
    if (checkoutPath.length === 0 || checkoutPath.length > WORK_ATTENTION_BOUNDS.maxPath) {
      return `checkoutPath must be 1 to ${String(WORK_ATTENTION_BOUNDS.maxPath)} characters`;
    }
    if (checkoutPath.includes('\0') || !path.isAbsolute(checkoutPath)) {
      return 'checkoutPath must be an absolute path';
    }
    return { checkoutPath: path.resolve(checkoutPath), kind: 'checkout', match: 'same-or-inside' };
  }
  const { projectLabel } = scope;
  if (projectLabel.trim().length === 0 || projectLabel.length > WORK_CONTEXT_BOUNDS.maxProjectLabel) {
    return `projectLabel must be 1 to ${String(WORK_CONTEXT_BOUNDS.maxProjectLabel)} characters`;
  }
  if (projectLabel.includes('\0') || projectLabel.includes('/') || projectLabel.includes(path.sep)) {
    return 'projectLabel is a directory name; pass a checkout path to scope by path';
  }
  return { kind: 'project-label', match: 'exact', projectLabel };
};

/**
 * A recorded path is compared as written, and only when it is absolute: a relative or foreign
 * (`C:\…` on Linux) path is never resolved against this process's working directory.
 */
const isSameOrInside = (candidate: string, target: string): boolean => {
  if (!path.isAbsolute(candidate)) {
    return false;
  }
  const relative = path.relative(target, path.resolve(candidate));
  return relative === '' || !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
};

const rootInScope = (root: WorkRoot, scope: WorkContextAppliedScope): boolean => {
  if (scope.kind === 'project-label') {
    return root.project.label === scope.projectLabel;
  }
  if (root.project.checkoutPath !== null && isSameOrInside(root.project.checkoutPath, scope.checkoutPath)) {
    return true;
  }
  // A child of the family may have worked in another checkout; its observed status names it.
  return root.facts.some(
    (fact) => fact.kind === 'checkout-status' && isSameOrInside(fact.checkoutPath, scope.checkoutPath),
  );
};

const referenceOf = (root: WorkRoot): WorkContextRootReference => ({
  archived: root.archived,
  desktopSessionId: root.desktopSessionId,
  key: root.key,
  project: root.project,
  title: root.title,
});

/** The date a fact carries for itself; provenance keeps when and where it was observed. */
const factDate = (fact: WorkFact): CanonicalInstant | null => {
  switch (fact.kind) {
    case 'declared-turn':
      return fact.declaredAt;
    case 'declared-pull-request':
      return fact.lastActivityAt;
    case 'pull-request':
      return fact.mergedAt ?? fact.updatedAt;
    case 'jira-issue':
      return fact.updatedAt;
    case 'proposal':
      return fact.createdAt;
    case 'side-session-note':
    case 'turn-report':
    case 'wrap-up':
      return fact.at;
    default:
      return null;
  }
};

const proposalCount = (count: number): string => (count === 1 ? 'One proposal' : `${count} proposals`);

/**
 * The dataset's proposal sentences name each proposal's title; the context cites proposals by id,
 * date and kind only (ADR 0058), so their reading text is rebuilt from the count alone.
 */
const proposalText = (interpretation: WorkInterpretation): string | null => {
  const count = interpretation.evidence.length;
  switch (interpretation.kind) {
    case 'proposal-open':
      return `${proposalCount(count)} open and unanswered (cited by id).`;
    case 'proposal-superseded':
      return `${proposalCount(count)} offered before a later message from you, no longer presented as pending (cited by id).`;
    case 'proposal-expired':
      return `${proposalCount(count)} expired in Claude Desktop (cited by id).`;
    default:
      return null;
  }
};

const readingOf = (interpretation: WorkInterpretation, facts: ReadonlyMap<string, WorkFact>): WorkContextReading => {
  const cited = interpretation.evidence.slice(0, WORK_CONTEXT_BOUNDS.maxEvidencePerReading);
  return {
    evidence: cited.map((id) => {
      const fact = facts.get(id);
      return fact === undefined
        ? { at: null, id, kind: null, provenance: null }
        : { at: factDate(fact), id, kind: fact.kind, provenance: fact.provenance };
    }),
    evidenceOmitted: interpretation.evidence.length - cited.length,
    kind: interpretation.kind,
    text: proposalText(interpretation) ?? interpretation.text,
    uncertainty: interpretation.uncertainty,
  };
};

const declaredProvenanceOf = (root: WorkRoot): WorkFactProvenance | null => {
  const { declared } = root;
  if (declared === null) {
    return null;
  }
  const fact = root.facts.find(
    (candidate) =>
      candidate.kind === 'declared-turn' &&
      candidate.desktopSessionId === root.desktopSessionId &&
      candidate.declaredAt === declared.at,
  );
  return fact?.provenance ?? null;
};

const waitOf = (root: WorkRoot, attention: WorkContextWait['attention'], facts: ReadonlyMap<string, WorkFact>) => {
  const open = root.interpretations.filter(({ kind }) => !isDecisionKind(kind));
  const kept = open.slice(0, WORK_CONTEXT_BOUNDS.maxReadingsPerWait);
  return {
    age: root.age,
    attention,
    declared: root.declared,
    declaredProvenance: declaredProvenanceOf(root),
    readings: kept.map((interpretation) => readingOf(interpretation, facts)),
    readingsOmitted: open.length - kept.length,
    reconsidered: root.reconsidered,
    root: referenceOf(root),
  } satisfies WorkContextWait;
};

const lowerHost = (host: string): string => host.trim().toLowerCase();

/** One identity per observation: a failed read and the older successful one behind it stay two items. */
const linkedKey = (fact: WorkFact): string | null => {
  switch (fact.kind) {
    case 'declared-pull-request':
      return JSON.stringify(['declared', lowerHost(fact.host), fact.repository, fact.number]);
    case 'pull-request':
      return JSON.stringify(['github', lowerHost(fact.host), fact.repository, fact.number, fact.provenance.observedAt]);
    case 'checkout-status':
      return JSON.stringify(['checkout', fact.checkoutPath, fact.provenance.observedAt]);
    case 'jira-issue':
      return JSON.stringify(['jira', fact.key, fact.provenance.observedAt]);
    default:
      return null;
  }
};

interface LinkedEntry {
  fact: WorkFact;
  readonly roots: string[];
}

const collectLinked = (roots: readonly WorkRoot[]): LinkedEntry[] => {
  const entries = new Map<string, LinkedEntry>();
  for (const root of roots) {
    for (const fact of root.facts) {
      const key = linkedKey(fact);
      if (key === null) {
        continue;
      }
      const entry = entries.get(key);
      if (entry === undefined) {
        entries.set(key, { fact, roots: root.desktopSessionId === null ? [] : [root.desktopSessionId] });
        continue;
      }
      // The same declared pull request listed by several roots: the newest listing speaks for it.
      if (fact.provenance.observedAt > entry.fact.provenance.observedAt) {
        entry.fact = fact;
      }
      if (
        root.desktopSessionId !== null &&
        !entry.roots.includes(root.desktopSessionId) &&
        entry.roots.length < WORK_CONTEXT_BOUNDS.maxRootsPerLinkedFact
      ) {
        entry.roots.push(root.desktopSessionId);
      }
    }
  }
  return [...entries.values()].sort((left, right) =>
    right.fact.provenance.observedAt.localeCompare(left.fact.provenance.observedAt),
  );
};

const pullRequestsOf = (
  entries: readonly LinkedEntry[],
): WorkContextLinkedFact<'declared-pull-request' | 'pull-request'>[] =>
  entries.flatMap(({ fact, roots }) =>
    fact.kind === 'declared-pull-request' || fact.kind === 'pull-request' ? [{ fact, roots: [...roots] }] : [],
  );
const checkoutsOf = (entries: readonly LinkedEntry[]): WorkContextLinkedFact<'checkout-status'>[] =>
  entries.flatMap(({ fact, roots }) => (fact.kind === 'checkout-status' ? [{ fact, roots: [...roots] }] : []));
const jiraIssuesOf = (entries: readonly LinkedEntry[]): WorkContextLinkedFact<'jira-issue'>[] =>
  entries.flatMap(({ fact, roots }) => (fact.kind === 'jira-issue' ? [{ fact, roots: [...roots] }] : []));

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Lists cut first when the encoding is over its ceiling: the least urgent first, the waits last. */
const BYTE_CUT_ORDER = ['jiraIssues', 'checkouts', 'pullRequests', 'decisions', 'waits'] as const;

/**
 * The pure projection of a Work attention dataset onto one scope. `queryWorkContext` feeds it from
 * the store. Throws `RangeError` for a scope `normalizeWorkContextScope` refuses.
 */
export const projectWorkContext = (dataset: WorkAttentionDataset, scope: WorkContextScope): WorkContextDataset => {
  const applied = normalizeWorkContextScope(scope);
  if (typeof applied === 'string') {
    throw new RangeError(`projectWorkContext: ${applied}`);
  }
  const roots = dataset.roots.filter((root) => rootInScope(root, applied));
  const waits: WorkContextWait[] = [];
  const decisions: (WorkContextDecision & { readonly sortAt: string })[] = [];
  for (const root of roots) {
    const facts = new Map(root.facts.map((fact) => [fact.id, fact]));
    if (isWaitingAttention(root.attention)) {
      waits.push(waitOf(root, root.attention, facts));
    }
    for (const interpretation of root.interpretations) {
      const { kind } = interpretation;
      if (isDecisionKind(kind)) {
        decisions.push({
          ...readingOf(interpretation, facts),
          kind,
          root: referenceOf(root),
          sortAt: root.age.lastActivityAt ?? root.age.declaredAt ?? '',
        });
      }
    }
  }
  // The last settled decisions first; a stable sort keeps a root's own order among its decisions.
  decisions.sort((left, right) => right.sortAt.localeCompare(left.sortAt));
  const linked = collectLinked(roots);
  const lists = {
    checkouts: checkoutsOf(linked),
    decisions: decisions.map(({ sortAt: _sortAt, ...decision }): WorkContextDecision => decision),
    jiraIssues: jiraIssuesOf(linked),
    pullRequests: pullRequestsOf(linked),
    waits,
  };
  const limits = {
    checkouts: WORK_CONTEXT_BOUNDS.maxCheckouts,
    decisions: WORK_CONTEXT_BOUNDS.maxDecisions,
    jiraIssues: WORK_CONTEXT_BOUNDS.maxJiraIssues,
    pullRequests: WORK_CONTEXT_BOUNDS.maxPullRequests,
    waits: WORK_CONTEXT_BOUNDS.maxWaits,
  };
  const omitted = {
    checkouts: Math.max(0, lists.checkouts.length - limits.checkouts),
    decisions: Math.max(0, lists.decisions.length - limits.decisions),
    jiraIssues: Math.max(0, lists.jiraIssues.length - limits.jiraIssues),
    pullRequests: Math.max(0, lists.pullRequests.length - limits.pullRequests),
    waits: Math.max(0, lists.waits.length - limits.waits),
  };
  const kept = {
    checkouts: lists.checkouts.slice(0, limits.checkouts),
    decisions: lists.decisions.slice(0, limits.decisions),
    jiraIssues: lists.jiraIssues.slice(0, limits.jiraIssues),
    pullRequests: lists.pullRequests.slice(0, limits.pullRequests),
    waits: lists.waits.slice(0, limits.waits),
  };
  const unscopedPaths =
    applied.kind === 'checkout'
      ? dataset.roots.filter(
          (root) => root.project.checkoutPath !== null && !path.isAbsolute(root.project.checkoutPath),
        ).length
      : 0;
  const codexInScope = roots.filter((root) => root.attention === 'not-observable').length;
  const { codexSessions } = dataset.coverage;
  const harnesses: WorkContextHarnessCoverage = {
    claudeDesktop: { inScope: roots.length - codexInScope, reads: 'declared-waits' },
    codex: {
      campaignsInWindow: codexSessions.campaignsInWindow,
      campaignsRead: codexSessions.campaignsRead,
      cutByPage: Math.max(
        codexSessions.campaignsRead - dataset.roots.filter((root) => root.attention === 'not-observable').length,
        0,
      ),
      inScope: codexInScope,
      reads: 'sessions-only',
    },
  };
  const notes: readonly WorkContextCoverageNote[] =
    codexSessions.campaignsRead > 0
      ? [WORK_CONTEXT_CODEX_NOTE, ...WORK_CONTEXT_COVERAGE_NOTES.filter(({ code }) => code !== 'claude-desktop-only')]
      : WORK_CONTEXT_COVERAGE_NOTES;
  const build = (bytes: boolean): WorkContextDataset => {
    const truncation = { bytes, dataset: dataset.truncated, omitted: { ...omitted } };
    return {
      coverage: {
        attention: dataset.coverage,
        harnesses,
        notes,
        roots: { inScope: roots.length, read: dataset.roots.length, total: dataset.totalRoots, unscopedPaths },
      },
      decisions: kept.decisions,
      generatedAt: dataset.generatedAt,
      linked: { checkouts: kept.checkouts, jiraIssues: kept.jiraIssues, pullRequests: kept.pullRequests },
      schemaVersion: WORK_CONTEXT_SCHEMA_VERSION,
      scope: applied,
      truncated: bytes || dataset.truncated || Object.values(omitted).some((count) => count > 0),
      truncation,
      waiting: kept.waits,
    };
  };
  let result = build(false);
  while (encodedBytes(result) > WORK_CONTEXT_BOUNDS.maxOutputBytes) {
    const list = BYTE_CUT_ORDER.find((name) => kept[name].length > 0);
    if (list === undefined) {
      // Only the scope and coverage remain; they are bounded far below the ceiling.
      throw new RangeError('projectWorkContext: the coverage alone exceeds the output bound');
    }
    kept[list].pop();
    omitted[list] += 1;
    result = build(true);
  }
  return result;
};

const invalidInput = (problem: string): UsageStoreError =>
  new UsageStoreError({
    message: `queryWorkContext: ${problem}`,
    operation: 'queryWorkContext',
    reason: 'invalid-input',
  });

export interface QueryWorkContextInput {
  readonly dbPath: string;
  readonly machineId?: string;
  readonly now?: Date;
  readonly scope: WorkContextScope;
}

/**
 * One bounded read through the read-only store connection: the Work attention read at its widest
 * page (`WORK_ATTENTION_BOUNDS.maxRoots`), then the projection onto the scope.
 */
export const queryWorkContext = (input: QueryWorkContextInput): Effect.Effect<WorkContextDataset, UsageStoreError> =>
  Effect.gen(function* () {
    const applied = normalizeWorkContextScope(input.scope);
    if (typeof applied === 'string') {
      return yield* Effect.fail(invalidInput(applied));
    }
    const dataset = yield* queryWorkAttention({
      dbPath: input.dbPath,
      limit: WORK_ATTENTION_BOUNDS.maxRoots,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return projectWorkContext(dataset, applied);
  });

const failure = (code: WorkContextFailureCode, message: string): WorkContextReadResult => ({
  failure: { code, message },
  kind: 'error',
});

const INCOMPATIBLE_REASONS = new Set(['corrupt', 'schema-too-new']);

/** Maps a store failure to its typed, path-free failure. */
export const workContextFailureOf = (error: UsageStoreError): WorkContextFailure => {
  const reason = usageStoreErrorReasonFrom(error);
  if (reason === 'store-missing') {
    return {
      code: 'store-missing',
      message: 'No usage store exists yet; the usage engine creates it on its first run.',
    };
  }
  if (reason === 'schema-too-old') {
    return {
      code: 'store-not-upgraded',
      message:
        'The usage store has not been upgraded for this version yet; the engine upgrades it when it next starts.',
    };
  }
  if (reason !== undefined && INCOMPATIBLE_REASONS.has(reason)) {
    return { code: 'incompatible-store', message: 'The usage store is not compatible with this version of ai-usage.' };
  }
  return { code: 'unavailable', message: 'The Work context could not be read from the usage store.' };
};

/**
 * The edge entry point shared by the CLI and the MCP tool: validates the scope, reads, and returns
 * either the dataset or a typed failure. A missing store is a failure, never an empty context: an
 * empty answer would read as "nothing is waiting". Cancellation through `signal` reads `cancelled`.
 */
export const readWorkContext = async (
  input: QueryWorkContextInput & { readonly signal?: AbortSignal },
): Promise<WorkContextReadResult> => {
  const applied = normalizeWorkContextScope(input.scope);
  if (typeof applied === 'string') {
    return failure('invalid-input', `The Work context scope is invalid: ${applied}.`);
  }
  if (input.signal?.aborted === true) {
    return failure('cancelled', 'The Work context read was cancelled.');
  }
  const { signal, ...query } = input;
  let result: Result.Result<WorkContextDataset, UsageStoreError>;
  try {
    result = await Effect.runPromise(
      Effect.result(queryWorkContext({ ...query, scope: applied })),
      signal === undefined ? undefined : { signal },
    );
  } catch (error) {
    if (signal?.aborted === true) {
      return failure('cancelled', 'The Work context read was cancelled.');
    }
    throw error;
  }
  if (Result.isSuccess(result)) {
    return { kind: 'success', value: result.success };
  }
  return { failure: workContextFailureOf(result.failure), kind: 'error' };
};
