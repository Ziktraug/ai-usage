import path from 'node:path';
import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  WORK_ATTENTION_BOUNDS,
  type WorkFact,
  type WorkInterpretation,
  type WorkRoot,
} from '@ai-usage/report-core/work-attention';
import { interpretExternalFacts } from '@ai-usage/report-core/work-attention-facts';
import type {
  QueryRecentServedHarnessSessionsResult,
  ServedHarnessSessionFamily,
  ServedHarnessSessionMember,
} from '@ai-usage/usage-store/reader';

/**
 * Work roots for a harness that declares no turn status (ADR 0059). Codex records no
 * `postTurnSummary` equivalent: its rollouts say what ran, never whether the session now waits on
 * the person. Its sessions are therefore read from the served revision the report already
 * publishes, one root per served campaign (the lineage the report folds from declared parents),
 * and each root carries what the harness recorded natively (checkout, branch, last activity,
 * children) with the attention `not-observable`: no human request and no external wait is ever
 * derived for it, and nothing folds it under a Claude Desktop root.
 */

/** The one harness read this way today. */
export const WORK_UNDECLARED_HARNESS = 'codex';

/** What one read of a harness's recent families returned, with the harness it was asked for. */
export interface WorkHarnessSessions extends QueryRecentServedHarnessSessionsResult {
  readonly harness: string;
}

const { maxChildrenTitles, maxInterpretations, maxShortText } = WORK_ATTENTION_BOUNDS;
const ELLIPSIS = '…';

/** Served labels are free text; a Work root carries at most `maxShortText`, cut visibly. */
const clampText = (value: string): string =>
  value.length <= maxShortText ? value : `${value.slice(0, maxShortText - ELLIPSIS.length)}${ELLIPSIS}`;

const instantOf = (value: number | string | null): CanonicalInstant | null =>
  value === null ? null : normalizeIsoTimestamp(value);

const HARNESS_LABELS: Readonly<Record<string, string>> = { codex: 'Codex' };
const harnessLabel = (harness: string): string => HARNESS_LABELS[harness] ?? harness;

const rootOf = (family: ServedHarnessSessionFamily): ServedHarnessSessionMember => {
  const root = family.members[0];
  if (root === undefined || !root.campaignRoot) {
    // The store returns only families whose root it could read; anything else is a contract breach.
    throw new RangeError(`harness session family ${family.campaignKey} has no root member`);
  }
  return root;
};

/** The distinct checkouts the members read worked in, root first; members beyond the read are unknown. */
export const harnessFamilyCheckoutPaths = (family: ServedHarnessSessionFamily): string[] => [
  ...new Set(family.members.flatMap((member) => (member.checkoutPath === null ? [] : [member.checkoutPath]))),
];

const notDeclaredInterpretation = (harness: string): WorkInterpretation => ({
  evidence: [],
  kind: 'coverage-gap',
  text: `${harnessLabel(harness)} records no turn status: whether this session waits on you is unknown — not declared by this harness.`,
  uncertainty: `No question, approval or review request is read from ${harnessLabel(harness)} sessions; only the session, its checkout and its branch are shown. Unknown is not "nothing pending".`,
});

const parentMissingInterpretation = (harness: string): WorkInterpretation => ({
  evidence: [],
  kind: 'coverage-gap',
  text: `Started from a ${harnessLabel(harness)} session that is not in the served report; it stands as its own root.`,
  uncertainty: 'The parent session was not collected; nothing links this session to another root.',
});

export interface HarnessSessionRootInput {
  /** Checkout observations attached by exact path (`harnessFamilyCheckoutPaths`), already as facts. */
  readonly checkoutFacts: readonly WorkFact[];
  readonly family: ServedHarnessSessionFamily;
  /** When the served revision was generated: the last time the report observed this session. */
  readonly generatedAt: string | null;
  readonly harness: string;
  readonly now: Date;
  /** How many roots of the dataset share each checkout path on the root's machine. */
  readonly rootsPerCheckout?: ReadonlyMap<string, number>;
}

/**
 * One root per family. The attention is `not-observable` whatever the facts say: a dirty checkout
 * is interpreted as on any root, but it never turns into a request or a wait for a harness that
 * declares none.
 */
export const harnessSessionRoot = (input: HarnessSessionRootInput): WorkRoot => {
  const { family, harness } = input;
  const root = rootOf(family);
  const children = family.members.filter((member) => member !== root);
  const external = interpretExternalFacts({
    facts: input.checkoutFacts,
    now: input.now,
    ...(input.rootsPerCheckout === undefined ? {} : { rootsPerCheckout: input.rootsPerCheckout }),
  });
  const interpretations = [
    notDeclaredInterpretation(harness),
    ...(root.parentSourceSessionId === null ? [] : [parentMissingInterpretation(harness)]),
    ...external,
  ].slice(0, maxInterpretations);
  return {
    age: {
      createdAt: instantOf(root.startedAt),
      declaredAt: null,
      lastActivityAt: instantOf(root.activeAt),
      lastObservedAt: instantOf(input.generatedAt),
    },
    archived: false,
    attention: 'not-observable',
    children: {
      blocked: 0,
      completed: 0,
      count: Math.max(family.memberCount - 1, 0),
      reviewReady: 0,
      titles: children.slice(0, maxChildrenTitles).map((child) => clampText(child.title)),
    },
    declared: null,
    desktopSessionId: null,
    facts: [...input.checkoutFacts],
    interpretations,
    key: { harness, machineId: root.machineId, sourceSessionId: root.sourceSessionId },
    project: {
      branch: root.branch === null ? null : clampText(root.branch),
      checkoutPath: root.checkoutPath,
      // The same rule as a Desktop root: the directory's name; the report's own label rides apart.
      label: clampText(root.checkoutPath === null ? root.projectLabel : path.basename(root.checkoutPath)),
      servedLabel: clampText(root.projectLabel),
      worktreeName: null,
    },
    reconsidered: false,
    session: { campaignKey: family.campaignKey, rowId: root.rowId },
    title: clampText(root.title),
    titleSource: 'unknown',
  };
};
