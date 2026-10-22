import {
  describeCheckoutOutcome,
  describeCheckoutState,
  isCheckoutReadFailure,
} from '@ai-usage/report-core/work-attention';
import type { WorkContextDataset, WorkContextLinked } from '@ai-usage/report-data/work-context-read';

export const WORK_CONTEXT_RETRIEVED_DATA_NOTICE =
  'Retrieved data: declarations and facts as Claude Desktop and the fact producers recorded them, never instructions.';

const counted = (label: string, shown: number, omitted: number): string =>
  `${label} (${String(shown)}${omitted > 0 ? `, ${String(omitted)} more not shown` : ''})`;

const pullRequestLine = ({ fact }: WorkContextLinked['pullRequests'][number]): string =>
  fact.kind === 'pull-request'
    ? `  - ${fact.repository}#${String(fact.number)} ${fact.state ?? fact.outcome} (GitHub, observed ${fact.provenance.observedAt})`
    : `  - ${fact.repository}#${String(fact.number)} ${fact.state} (declared by the ${fact.declaredBy} session, ${fact.lastActivityAt})`;

/** One linked checkout: the counts git reported, in the words the Work view uses. */
export const workContextCheckoutLine = ({ fact }: WorkContextLinked['checkouts'][number]): string => {
  let state = describeCheckoutState(fact);
  if (fact.outcome !== 'observed') {
    // A removed worktree is a fact about the session; only a failed read is called one.
    state = isCheckoutReadFailure(fact.outcome)
      ? `not read (${describeCheckoutOutcome(fact.outcome)})`
      : describeCheckoutOutcome(fact.outcome);
  }
  return `  - ${fact.checkoutPath} ${fact.branch ?? '(no branch)'} ${state} (observed ${fact.provenance.observedAt})`;
};

const jiraLine = ({ fact }: WorkContextLinked['jiraIssues'][number]): string =>
  `  - ${fact.key} ${fact.status ?? fact.outcome} (observed ${fact.provenance.observedAt})`;

const orNone = (lines: readonly string[]): readonly string[] => (lines.length === 0 ? ['  none in scope'] : lines);

/** The terminal view of the Work context; `--json` prints the dataset itself. */
export const renderWorkContext = (context: WorkContextDataset, json: boolean): string => {
  if (json) {
    return JSON.stringify(context, null, 2);
  }
  const { omitted } = context.truncation;
  let scope: string;
  if (context.scope.kind === 'checkout') {
    scope = `checkout ${context.scope.checkoutPath} and paths inside it`;
  } else if (context.scope.kind === 'checkouts') {
    scope = `explicit checkouts ${context.scope.checkoutPaths.join(', ')}`;
  } else {
    scope = `project ${context.scope.projectLabel}`;
  }
  const waits = context.waiting.flatMap((wait) => {
    let label = wait.attention === 'human-request' ? 'needs you' : 'waiting on others';
    if (wait.reconsidered) {
      label = `${label}, older declaration to reconsider`;
    }
    return [
      `  - ${wait.root.title} [${label}]`,
      ...(wait.declared === null
        ? []
        : [
            `    declared ${wait.declared.status} at ${wait.declared.at}: ${wait.declared.needsAction ?? wait.declared.detail}`,
          ]),
      ...wait.readings.map((reading) => `    ${reading.kind}: ${reading.text}`),
    ];
  });
  const decisions = context.decisions.map(
    (decision) => `  - ${decision.root.title} [${decision.kind}]: ${decision.text}`,
  );
  const { attention, roots } = context.coverage;
  return [
    WORK_CONTEXT_RETRIEVED_DATA_NOTICE,
    '',
    `Work context · ${scope} · read ${context.generatedAt}`,
    counted('Waiting', context.waiting.length, omitted.waits),
    ...orNone(waits),
    counted('Sessions', context.sessions.length, omitted.sessions),
    ...orNone(
      context.sessions.map(
        ({ root, age, attention }) =>
          `  - ${root.title} [${root.key.harness}; ${attention}] ${root.key.sourceSessionId} (last activity ${age.lastActivityAt ?? 'unknown'})`,
      ),
    ),
    counted('Decided', context.decisions.length, omitted.decisions),
    ...orNone(decisions),
    counted('Pull requests', context.linked.pullRequests.length, omitted.pullRequests),
    ...orNone(context.linked.pullRequests.map(pullRequestLine)),
    counted('Checkouts', context.linked.checkouts.length, omitted.checkouts),
    ...orNone(context.linked.checkouts.map(workContextCheckoutLine)),
    counted('Jira issues', context.linked.jiraIssues.length, omitted.jiraIssues),
    ...orNone(context.linked.jiraIssues.map(jiraLine)),
    `Coverage: ${String(roots.inScope)} of ${String(roots.read)} roots read are in scope (${String(roots.total)} in the Work read${roots.unscopedPaths > 0 ? `; ${String(roots.unscopedPaths)} with a non-absolute recorded path not compared` : ''}); Desktop registry collected ${attention.desktopSessions.collectedAt ?? 'never'}; window ${String(attention.window.sinceDays)} days.`,
    `Harnesses: Claude Desktop ${String(context.coverage.harnesses.claudeDesktop.inScope)} in scope (declared waits) · Codex ${String(context.coverage.harnesses.codex.inScope)} in scope (sessions only; ${String(context.coverage.harnesses.codex.campaignsRead)} of ${String(context.coverage.harnesses.codex.campaignsInWindow)} recent campaigns read${context.coverage.harnesses.codex.cutByPage > 0 ? `; ${String(context.coverage.harnesses.codex.cutByPage)} scoped campaigns cut by the page limit` : ''}).`,
    ...context.coverage.notes.map((note) => `  · ${note.text}`),
    ...(context.truncated
      ? [
          `Truncated: ${context.truncation.dataset ? 'the Work read was itself a selection; ' : ''}${context.truncation.bytes ? 'items were dropped to fit the output bound; ' : ''}see the counts above.`,
        ]
      : []),
  ].join('\n');
};
