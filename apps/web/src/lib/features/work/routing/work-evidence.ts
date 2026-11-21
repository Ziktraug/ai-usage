/** Bounded projection seam; these observations are not inferred from usage or checkout proximity. */
export interface WorkIdentity {
  readonly harness: string;
  readonly machineId: string;
  readonly sessionId: string;
}
export interface WorkPullRequest {
  readonly host: string;
  readonly number: number;
  readonly repository: string;
}
interface EvidenceBase {
  readonly coverage: 'complete' | 'partial';
  readonly id: string;
  readonly observedAt: string;
  readonly session: WorkIdentity;
  readonly source: string;
}
export type WorkEvidence = EvidenceBase &
  (
    | { readonly kind: 'pr-request'; readonly repository: Pick<WorkPullRequest, 'host' | 'repository'> }
    | {
        readonly kind: 'pr-opened';
        readonly pullRequest: WorkPullRequest;
        readonly fulfillsRequest: { readonly session: WorkIdentity; readonly requestId: string } | null;
      }
    | { readonly kind: 'local-modifications' }
    | { readonly kind: 'proposal'; readonly response: 'unanswered' | 'dismissed' }
  );
export interface WorkInterpretation {
  readonly evidence: readonly WorkEvidence[];
  readonly kind: 'waiting' | 'observed' | 'proposal';
  readonly text: string;
  readonly uncertainty: string;
}
export const workIdentityKey = (identity: WorkIdentity): string =>
  JSON.stringify([identity.machineId, identity.harness, identity.sessionId]);

export const projectWorkEvidence = (
  identity: WorkIdentity,
  observations: readonly WorkEvidence[],
): readonly WorkInterpretation[] => {
  const scoped = observations.filter((entry) => workIdentityKey(entry.session) === workIdentityKey(identity));
  return scoped.flatMap((entry): WorkInterpretation[] => {
    if (entry.kind === 'pr-opened') {
      return [];
    }
    if (entry.kind === 'pr-request') {
      const opened = observations.find(
        (candidate) =>
          candidate.kind === 'pr-opened' &&
          candidate.fulfillsRequest?.requestId === entry.id &&
          workIdentityKey(candidate.fulfillsRequest.session) === workIdentityKey(entry.session) &&
          candidate.pullRequest.host === entry.repository.host &&
          candidate.pullRequest.repository === entry.repository.repository &&
          Date.parse(candidate.observedAt) >= Date.parse(entry.observedAt),
      );
      return [
        {
          kind: opened ? 'observed' : 'waiting',
          text: opened ? 'Requested PR observed open' : 'PR creation requested; completion unobserved',
          evidence: opened ? [entry, opened] : [entry],
          uncertainty: opened
            ? 'Opening does not prove merge or deployment.'
            : 'The request may have been completed elsewhere.',
        },
      ];
    }
    if (entry.kind === 'local-modifications') {
      return [
        {
          kind: 'observed',
          text: 'Local modifications observed',
          evidence: [entry],
          uncertainty: 'Validation and delivery are unobserved.',
        },
      ];
    }
    return [
      {
        kind: 'proposal',
        text: entry.response === 'unanswered' ? 'Proposal unanswered' : 'Proposal dismissed; reason undeclared',
        evidence: [entry],
        uncertainty: 'This is not authorization to execute a task.',
      },
    ];
  });
};

export const workParentCoverage = (
  child: { readonly session: WorkIdentity; readonly parentSessionId: string | null },
  known: readonly WorkIdentity[],
): string => {
  if (!child.parentSessionId) {
    return 'Parent not declared';
  }
  const parent = { ...child.session, sessionId: child.parentSessionId };
  return known.some((entry) => workIdentityKey(entry) === workIdentityKey(parent))
    ? 'Explicit parent observed'
    : 'Declared parent is outside this bounded observation; absence is not established';
};
