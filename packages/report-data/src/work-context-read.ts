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
import {
  MAX_WORK_SCOPE_CHECKOUTS,
  UsageStoreError,
  usageStoreErrorReasonFrom,
  type WorkSessionReadScope,
} from '@ai-usage/usage-store/reader';
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
  maxScopeCheckouts: MAX_WORK_SCOPE_CHECKOUTS,
  maxSessions: 20,
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
    text: 'A declaration is what a session stated at its last turn end, as the Claude Desktop registry recorded it, dated by the session. Codex contributes bounded native structured input requests and exact response identities, not a general transcript or inferred turn status.',
  },
  {
    code: 'declared-links-only',
    text: 'Pull request, checkout and Jira facts appear only when a session of the family declared the pull request, wrote the Jira key in a branch name, or worked in the checkout.',
  },
  {
    code: 'scope-before-budget',
    text: 'scopeAppliedBeforeBounds names whether the store selected the explicit scope before its bounded pages; a projection of a supplied dataset only covers that page. Root counts describe that scoped read, not the entire corpus. Native parents are retained when a child matches; previews do not enumerate every family member. Absence from a bounded page is not absence from the corpus.',
  },
  {
    code: 'activity-window',
    text: 'Desktop roots with nothing pending and no activity within coverage.attention.window.sinceDays are left out; their requests and external waits are kept at any age. Codex request evidence covers only the selected served campaigns and bounded members in that activity window; older or omitted requests may remain pending.',
  },
  {
    code: 'literal-paths',
    text: 'Checkout paths are compared literally with directory boundaries. Symbolic links are not resolved. Use checkoutPaths to include up to 10 explicitly known worktrees outside a checkout; names, branches and dates never link them. Non-absolute recorded paths are never matched to checkout scopes.',
  },
] as const;

/**
 * Replaces the `claude-desktop-only` note when the read included Codex campaigns (ADR 0059): their
 * sessions may carry bounded native request evidence, without a general turn declaration.
 */
export const WORK_CONTEXT_CODEX_NOTE = {
  code: 'desktop-waits-codex-sessions',
  text: 'Claude Desktop sessions carry their declared waits. Codex sessions include supported native structured requests: acceptance is not a human answer, and only an exact linked response settles its questions. General turn status and runtime approvals remain unknown. Coverage is limited to the selected served campaign members; older or omitted requests may remain pending. Claude Code outside Desktop, OpenCode and Cursor are not represented.',
} as const;

export type WorkContextCoverageNote = (typeof WORK_CONTEXT_COVERAGE_NOTES)[number] | typeof WORK_CONTEXT_CODEX_NOTE;

/** What each harness contributes to the context: declared waits, or native structured requests. */
export interface WorkContextHarnessCoverage {
  readonly claudeDesktop: { readonly inScope: number; readonly reads: 'declared-waits' };
  readonly codex: {
    /** Recent served Codex campaigns active in the window, and how many the Work read took (ADR 0059). */
    readonly campaignsInWindow: number;
    readonly campaignsRead: number;
    /**
     * Scoped campaigns read that the final page limit cut (Desktop roots rank first).
     */
    readonly cutByPage: number;
    readonly inScope: number;
    readonly reads: 'native-requests';
  };
}

export type WorkContextScope =
  | { readonly checkoutPath: string; readonly kind: 'checkout' }
  | { readonly checkoutPaths: readonly string[]; readonly kind: 'checkouts' }
  | { readonly kind: 'project-label'; readonly projectLabel: string };

/** The scope as applied: a checkout matches roots in that path or inside it, a label matches exactly. */
export type WorkContextAppliedScope =
  | { readonly checkoutPath: string; readonly kind: 'checkout'; readonly match: 'same-or-inside' }
  | { readonly checkoutPaths: readonly string[]; readonly kind: 'checkouts'; readonly match: 'same-or-inside' }
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
  readonly sessions: number;
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
    /** Roots the bounded read returned; queryWorkContext applies its scope before the read budgets. */
    readonly read: number;
    /** Roots counted in the scoped read, including those its window or page left out; not the whole corpus. */
    readonly total: number;
    /**
     * Roots read whose recorded checkout path is not absolute (relative, or another platform's):
     * never compared with a checkout scope, so never in it; 0 for a project-label scope.
     */
    readonly unscopedPaths: number;
  };
  /** False only for a projection of an already bounded dataset supplied by a caller. */
  readonly scopeAppliedBeforeBounds: boolean;
}

/** Compact native root reference, including quiet explorations and sessions with unknown attention. */
export interface WorkContextSession {
  readonly age: WorkRootAge;
  readonly attention: WorkRoot['attention'];
  readonly root: WorkContextRootReference;
  readonly session: WorkRoot['session'];
}

export interface WorkContextDataset {
  readonly coverage: WorkContextCoverage;
  readonly decisions: readonly WorkContextDecision[];
  readonly generatedAt: CanonicalInstant;
  readonly linked: WorkContextLinked;
  readonly schemaVersion: typeof WORK_CONTEXT_SCHEMA_VERSION;
  readonly scope: WorkContextAppliedScope;
  readonly sessions: readonly WorkContextSession[];
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
  if (scope.kind === 'checkouts') {
    if (scope.checkoutPaths.length === 0 || scope.checkoutPaths.length > WORK_CONTEXT_BOUNDS.maxScopeCheckouts) {
      return `checkoutPaths must contain 1 to ${String(WORK_CONTEXT_BOUNDS.maxScopeCheckouts)} explicit paths`;
    }
    const paths: string[] = [];
    for (const checkoutPath of scope.checkoutPaths) {
      const normalized = normalizeWorkContextScope({ checkoutPath, kind: 'checkout' });
      if (typeof normalized === 'string') {
        return normalized;
      }
      if (normalized.kind === 'checkout') {
        paths.push(normalized.checkoutPath);
      }
    }
    return { checkoutPaths: [...new Set(paths)], kind: 'checkouts', match: 'same-or-inside' };
  }
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
  const paths = scope.kind === 'checkout' ? [scope.checkoutPath] : scope.checkoutPaths;
  if (
    root.project.checkoutPath !== null &&
    paths.some((target) => isSameOrInside(root.project.checkoutPath ?? '', target))
  ) {
    return true;
  }
  // A child of the family may have worked in another checkout; its observed status names it.
  return root.facts.some(
    (fact) => fact.kind === 'checkout-status' && paths.some((target) => isSameOrInside(fact.checkoutPath, target)),
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
    case 'codex-user-request':
      return fact.request.askedAt;
    case 'codex-session-context':
      return fact.provenance.observedAt;
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
const BYTE_CUT_ORDER = ['sessions', 'jiraIssues', 'checkouts', 'pullRequests', 'decisions', 'waits'] as const;

/**
 * The pure projection of a Work attention dataset onto one scope. `queryWorkContext` feeds it from
 * the store. Throws `RangeError` for a scope `normalizeWorkContextScope` refuses.
 */
export const projectWorkContext = (
  dataset: WorkAttentionDataset,
  scope: WorkContextScope,
  /** Store-scoped reads already selected families by any member, including members outside the preview. */
  selection: 'project-dataset' | 'already-scoped' = 'project-dataset',
): WorkContextDataset => {
  const applied = normalizeWorkContextScope(scope);
  if (typeof applied === 'string') {
    throw new RangeError(`projectWorkContext: ${applied}`);
  }
  const roots =
    selection === 'already-scoped' ? dataset.roots : dataset.roots.filter((root) => rootInScope(root, applied));
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
    sessions: roots.map(
      (root): WorkContextSession => ({
        root: referenceOf(root),
        age: root.age,
        attention: root.attention,
        session: root.session,
      }),
    ),
    checkouts: checkoutsOf(linked),
    decisions: decisions.map(({ sortAt: _sortAt, ...decision }): WorkContextDecision => decision),
    jiraIssues: jiraIssuesOf(linked),
    pullRequests: pullRequestsOf(linked),
    waits,
  };
  const limits = {
    sessions: WORK_CONTEXT_BOUNDS.maxSessions,
    checkouts: WORK_CONTEXT_BOUNDS.maxCheckouts,
    decisions: WORK_CONTEXT_BOUNDS.maxDecisions,
    jiraIssues: WORK_CONTEXT_BOUNDS.maxJiraIssues,
    pullRequests: WORK_CONTEXT_BOUNDS.maxPullRequests,
    waits: WORK_CONTEXT_BOUNDS.maxWaits,
  };
  const omitted = {
    sessions: Math.max(0, lists.sessions.length - limits.sessions),
    checkouts: Math.max(0, lists.checkouts.length - limits.checkouts),
    decisions: Math.max(0, lists.decisions.length - limits.decisions),
    jiraIssues: Math.max(0, lists.jiraIssues.length - limits.jiraIssues),
    pullRequests: Math.max(0, lists.pullRequests.length - limits.pullRequests),
    waits: Math.max(0, lists.waits.length - limits.waits),
  };
  const kept = {
    sessions: lists.sessions.slice(0, limits.sessions),
    checkouts: lists.checkouts.slice(0, limits.checkouts),
    decisions: lists.decisions.slice(0, limits.decisions),
    jiraIssues: lists.jiraIssues.slice(0, limits.jiraIssues),
    pullRequests: lists.pullRequests.slice(0, limits.pullRequests),
    waits: lists.waits.slice(0, limits.waits),
  };
  const unscopedPaths =
    applied.kind === 'project-label'
      ? 0
      : dataset.roots.filter(
          (root) => root.project.checkoutPath !== null && !path.isAbsolute(root.project.checkoutPath),
        ).length;
  const codexInScope = roots.filter((root) => root.key.harness === 'codex').length;
  const { codexSessions } = dataset.coverage;
  const harnesses: WorkContextHarnessCoverage = {
    claudeDesktop: { inScope: roots.length - codexInScope, reads: 'declared-waits' },
    codex: {
      campaignsInWindow: codexSessions.campaignsInWindow,
      campaignsRead: codexSessions.campaignsRead,
      cutByPage: Math.max(
        codexSessions.campaignsRead - dataset.roots.filter((root) => root.key.harness === 'codex').length,
        0,
      ),
      inScope: codexInScope,
      reads: 'native-requests',
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
        scopeAppliedBeforeBounds: selection === 'already-scoped',
        attention: dataset.coverage,
        harnesses,
        notes,
        roots: { inScope: roots.length, read: dataset.roots.length, total: dataset.totalRoots, unscopedPaths },
      },
      decisions: kept.decisions,
      sessions: kept.sessions,
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
  /** Explicit exploration window (1–3650 days); defaults to the same 30 days as Work. */
  readonly sinceDays?: number;
}

/**
 * The scope is applied by the store before the bounded Work read. A matching family retains its
 * native root even when another member provided the scope match; no lineage is inferred.
 */
export const queryWorkContext = (input: QueryWorkContextInput): Effect.Effect<WorkContextDataset, UsageStoreError> =>
  Effect.gen(function* () {
    const applied = normalizeWorkContextScope(input.scope);
    if (typeof applied === 'string') {
      return yield* Effect.fail(invalidInput(applied));
    }
    const scope: WorkSessionReadScope =
      applied.kind === 'project-label'
        ? applied
        : {
            checkoutPaths: applied.kind === 'checkout' ? [applied.checkoutPath] : applied.checkoutPaths,
            kind: 'checkouts',
          };
    const dataset = yield* queryWorkAttention({
      scope,
      ...(input.sinceDays === undefined ? {} : { sinceDays: input.sinceDays }),
      dbPath: input.dbPath,
      limit: WORK_ATTENTION_BOUNDS.maxRoots,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return projectWorkContext(dataset, applied, 'already-scoped');
  });

const failure = (code: WorkContextFailureCode, message: string): WorkContextReadResult => ({
  failure: { code, message },
  kind: 'error',
});

const INCOMPATIBLE_REASONS = new Set(['corrupt', 'schema-too-new']);

/** Maps a store failure to its typed, path-free failure. */
export const workContextFailureOf = (error: UsageStoreError): WorkContextFailure => {
  const reason = usageStoreErrorReasonFrom(error);
  if (reason === 'invalid-input') {
    return { code: 'invalid-input', message: 'The Work context query bounds are invalid.' };
  }
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
