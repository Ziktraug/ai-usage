import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { normalizeIsoTimestamp } from '@ai-usage/report-core/provider-status';
import {
  type JiraIssueObservation,
  type PullRequestObservation,
  parseJiraIssueObservation,
  parsePullRequestObservation,
} from '@ai-usage/report-core/work-attention';
import {
  isWorkThreadId,
  parseWorkThreadLinkKey,
  type WorkThread,
  type WorkThreadWait,
} from '@ai-usage/report-core/work-thread';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { keptThreadIdOf, memberThreadIdsOf } from './work-thread-combination';
import {
  addEvent,
  canonicalLinkKey,
  instant,
  invalidInput,
  notCombinedMemberSql,
  read,
  readThread,
  record,
  type SqliteDatabase,
  saveThread,
  taskThreadsSql,
  threadFromRecord,
  validated,
  waitLinkKind,
  write,
} from './work-thread-rows';

const MAX_WAIT_CANDIDATES = 500;
interface WorkThreadWaitFact {
  readonly mergedAt: CanonicalInstant | null;
  readonly observedAt: CanonicalInstant;
  readonly state: string | null;
  readonly updatedAt: CanonicalInstant | null;
  readonly value: string | null;
}

/** Captured before a provider read; the writer rechecks this revision and active link. */
export interface WorkThreadWaitCandidate {
  readonly followRevision: number;
  readonly history: readonly WorkThreadWaitFact[];
  readonly linkId: string;
  readonly threadId: string;
  readonly waitingOn: WorkThreadWait;
}

export interface QueryWorkThreadWaitCandidatesInput {
  readonly dbPath: string;
  readonly kind: WorkThreadWait['kind'];
  readonly linkKeys: readonly string[];
  readonly machineId: string;
}

export interface QueryWorkThreadWaitCandidatesResult {
  readonly candidates: readonly WorkThreadWaitCandidate[];
  readonly truncated: boolean;
}

export interface ApplyWorkThreadWaitObservationsInput {
  readonly candidates: readonly WorkThreadWaitCandidate[];
  readonly dbPath: string;
  readonly jiraIssues?: readonly JiraIssueObservation[];
  readonly machineId: string;
  readonly now: string;
  readonly pullRequests?: readonly PullRequestObservation[];
}

export interface ApplyWorkThreadWaitObservationsResult {
  readonly satisfied: number;
  readonly unchanged: number;
  /** New source updates whose retained history cannot establish a change after the wait. */
  readonly unproven: number;
}

const storedWaitFacts = (
  db: SqliteDatabase,
  machineId: string,
  wait: WorkThreadWait,
  observedAt?: CanonicalInstant,
): readonly WorkThreadWaitFact[] => {
  const parsed = parseWorkThreadLinkKey(waitLinkKind(wait.kind), wait.linkKey);
  if (
    parsed === null ||
    (parsed.kind !== 'pull-request' && parsed.kind !== 'jira-issue') ||
    (parsed.kind === 'jira-issue' && parsed.site !== 'default')
  ) {
    return [];
  }
  const parameters: unknown[] =
    parsed.kind === 'pull-request'
      ? [machineId, parsed.host.toLowerCase(), parsed.repository.toLowerCase(), parsed.number]
      : [machineId, parsed.key];
  if (observedAt !== undefined) {
    parameters.push(observedAt);
  }
  const values = db
    .query(
      parsed.kind === 'pull-request'
        ? `SELECT observed_at, updated_at, merged_at, state, review_decision AS value
      FROM pull_request_observations WHERE machine_id = ? AND lower(host) = ? AND lower(repository) = ?
      AND number = ? AND outcome = 'observed' ${observedAt === undefined ? '' : 'AND observed_at = ?'}
      ORDER BY observed_at DESC, id DESC LIMIT 6`
        : `SELECT observed_at, updated_at, NULL AS merged_at, NULL AS state, status AS value
      FROM jira_issue_observations WHERE machine_id = ? AND issue_key = ? AND outcome = 'observed'
      ${observedAt === undefined ? '' : 'AND observed_at = ?'} ORDER BY observed_at DESC, id DESC LIMIT 6`,
    )
    .all(...parameters);
  return values.map((value) => {
    const row = record(value);
    const optionalDate = (date: unknown): CanonicalInstant | null =>
      date === null ? null : validated(normalizeIsoTimestamp(date), 'wait fact date');
    const optionalText = (text: unknown): string | null =>
      text === null ? null : validated(typeof text === 'string' ? text : null, 'wait fact text');
    return {
      observedAt: validated(normalizeIsoTimestamp(row.observed_at), 'wait fact observation date'),
      updatedAt: optionalDate(row.updated_at),
      mergedAt: optionalDate(row.merged_at),
      state: optionalText(row.state),
      value: optionalText(row.value),
    };
  });
};

const waitEvidence = (
  candidate: WorkThreadWaitCandidate,
  facts: readonly WorkThreadWaitFact[],
  now: CanonicalInstant,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
): { readonly reason: string | null; readonly unproven: boolean } => {
  const wait = candidate.waitingOn;
  const known: WorkThreadWaitFact[] = [];
  let unproven = false;
  for (const fact of facts
    .filter((item) => item.observedAt <= now)
    .toSorted((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    if (wait.kind === 'pull-request-review' && fact.state === 'MERGED') {
      if (fact.mergedAt !== null && fact.mergedAt > wait.since && fact.mergedAt <= now) {
        return { reason: `Pull request MERGED at ${fact.mergedAt}`, unproven: false };
      }
      continue;
    }
    const qualifies = wait.kind === 'jira-update' || fact.value === 'APPROVED' || fact.value === 'CHANGES_REQUESTED';
    if (
      qualifies &&
      fact.value !== null &&
      (fact.updatedAt === null || (fact.updatedAt > wait.since && fact.updatedAt <= now))
    ) {
      // Provider observedAt is the start of its read. A source change during that read
      // may be later, so application time, not observedAt, is the upper bound.
      const previous = known.findLast(
        (item) =>
          item.observedAt >= wait.since &&
          item.observedAt < fact.observedAt &&
          item.value !== fact.value &&
          fact.updatedAt !== null &&
          item.observedAt <= fact.updatedAt,
      );
      if (previous !== undefined && fact.updatedAt !== null) {
        return {
          reason:
            wait.kind === 'pull-request-review'
              ? `Pull request review ${fact.value}; source updated at ${fact.updatedAt}; previous ${previous.value} observed at ${previous.observedAt}`
              : `Jira status ${previous.value?.slice(0, 96)} -> ${fact.value.slice(0, 96)}; source updated at ${fact.updatedAt}; previous observed at ${previous.observedAt}`,
          unproven: false,
        };
      }
      unproven = true;
    }
    if (
      fact.value !== null &&
      (wait.kind === 'jira-update' || ['REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED'].includes(fact.value))
    ) {
      known.push(fact);
    }
  }
  return { reason: null, unproven };
};

export const queryWorkThreadWaitCandidates = (
  input: QueryWorkThreadWaitCandidatesInput,
): Effect.Effect<QueryWorkThreadWaitCandidatesResult, UsageStoreError> =>
  read(input.dbPath, 'queryWorkThreadWaitCandidates', (db) => {
    if (
      !(input.machineId && ['pull-request-review', 'jira-update'].includes(input.kind)) ||
      input.linkKeys.length > MAX_WAIT_CANDIDATES
    ) {
      return invalidInput('Invalid work thread wait scope');
    }
    const kind = waitLinkKind(input.kind);
    const keys = [...new Set(input.linkKeys.map((key) => canonicalLinkKey(kind, key)))];
    if (keys.some((key) => !parseWorkThreadLinkKey(kind, key))) {
      return invalidInput('Invalid work thread wait link');
    }
    if (keys.length === 0) {
      return { candidates: [], truncated: false };
    }
    const linkKey = kind === 'pull-request' ? 'lower(l.link_key)' : 'l.link_key';
    const waitKey =
      kind === 'pull-request'
        ? "lower(json_extract(t.waiting_on_json, '$.linkKey'))"
        : "json_extract(t.waiting_on_json, '$.linkKey')";
    const rows = db
      .query(`SELECT * FROM (
        SELECT t.*, l.link_id AS waited_link_id, ROW_NUMBER() OVER (
          PARTITION BY t.thread_id ORDER BY l.created_at, l.link_id) AS candidate_rank
        FROM work_threads t JOIN work_thread_links l ON l.thread_id IN ${taskThreadsSql('t')}
        WHERE t.machine_id = ? AND t.follow_state = 'waiting' AND ${notCombinedMemberSql('t')}
          AND json_extract(t.waiting_on_json, '$.kind') = ? AND l.kind = ? AND l.detached_at IS NULL
          AND ${linkKey} = ${waitKey} AND ${linkKey} IN (SELECT value FROM json_each(?))
      ) WHERE candidate_rank = 1 ORDER BY updated_at, thread_id LIMIT ?`)
      .all(input.machineId, input.kind, kind, JSON.stringify(keys), MAX_WAIT_CANDIDATES + 1);
    const historyByKey = new Map<string, readonly WorkThreadWaitFact[]>();
    const candidates = rows.slice(0, MAX_WAIT_CANDIDATES).map((row): WorkThreadWaitCandidate => {
      const thread = threadFromRecord(row);
      const waitingOn = validated(thread.waitingOn, 'wait candidate');
      const normalizedWait = { ...waitingOn, linkKey: canonicalLinkKey(kind, waitingOn.linkKey) };
      if (!historyByKey.has(normalizedWait.linkKey)) {
        historyByKey.set(normalizedWait.linkKey, storedWaitFacts(db, input.machineId, normalizedWait));
      }
      return {
        threadId: thread.threadId,
        followRevision: thread.followRevision,
        waitingOn: normalizedWait,
        linkId: validated(
          isWorkThreadId(record(row).waited_link_id) ? String(record(row).waited_link_id) : null,
          'wait link',
        ),
        history: historyByKey.get(normalizedWait.linkKey) ?? [],
      };
    });
    return { candidates, truncated: rows.length > MAX_WAIT_CANDIDATES };
  });

export const applyWorkThreadWaitObservations = (
  input: ApplyWorkThreadWaitObservationsInput,
): Effect.Effect<ApplyWorkThreadWaitObservationsResult, UsageStoreError> =>
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
  write(input.dbPath, 'applyWorkThreadWaitObservations', (db) => {
    const now = instant(input.now);
    if (
      !input.machineId ||
      input.candidates.length > MAX_WAIT_CANDIDATES ||
      (input.pullRequests?.length ?? 0) > MAX_WAIT_CANDIDATES ||
      (input.jiraIssues?.length ?? 0) > MAX_WAIT_CANDIDATES
    ) {
      return invalidInput('Invalid or over-bound work thread wait observations');
    }
    const incoming = new Map<string, WorkThreadWaitFact>();
    const add = (key: string, fact: WorkThreadWaitFact): void => {
      if (fact.observedAt <= now && (!incoming.has(key) || incoming.get(key)!.observedAt < fact.observedAt)) {
        incoming.set(key, fact);
      }
    };
    for (const value of input.pullRequests ?? []) {
      const observation = parsePullRequestObservation(value) ?? invalidInput('Invalid pull request wait observation');
      if (observation.machineId === input.machineId && observation.outcome === 'observed') {
        add(`${observation.host.toLowerCase()}/${observation.repository.toLowerCase()}#${observation.number}`, {
          observedAt: observation.observedAt,
          updatedAt: observation.updatedAt,
          mergedAt: observation.mergedAt,
          state: observation.state,
          value: observation.reviewDecision,
        });
      }
    }
    for (const value of input.jiraIssues ?? []) {
      const observation = parseJiraIssueObservation(value) ?? invalidInput('Invalid Jira wait observation');
      if (observation.machineId === input.machineId && observation.outcome === 'observed') {
        add(`jira:default/${observation.key}`, {
          observedAt: observation.observedAt,
          updatedAt: observation.updatedAt,
          mergedAt: null,
          state: null,
          value: observation.status,
        });
      }
    }
    const result = { satisfied: 0, unchanged: 0, unproven: 0 };
    for (const candidate of input.candidates) {
      const thread = readThread(db, candidate.threadId);
      const wait = thread?.waitingOn;
      const kind = waitLinkKind(candidate.waitingOn.kind);
      if (
        !thread ||
        thread.machineId !== input.machineId ||
        thread.followState !== 'waiting' ||
        thread.followRevision !== candidate.followRevision ||
        wait === null ||
        wait === undefined ||
        wait.kind !== candidate.waitingOn.kind ||
        wait.since !== candidate.waitingOn.since ||
        canonicalLinkKey(kind, wait.linkKey) !== candidate.waitingOn.linkKey ||
        keptThreadIdOf(db, thread.threadId) !== null ||
        db
          .query(
            `SELECT 1 FROM work_thread_links WHERE link_id = ? AND detached_at IS NULL
              AND thread_id IN (SELECT value FROM json_each(?))`,
          )
          .get(candidate.linkId, JSON.stringify([thread.threadId, ...memberThreadIdsOf(db, thread.threadId)])) === null
      ) {
        result.unchanged++;
        continue;
      }
      const fact = incoming.get(candidate.waitingOn.linkKey);
      const facts = [...candidate.history];
      // Only facts successfully imported by the writer may satisfy an expectation.
      if (fact !== undefined) {
        const stored = storedWaitFacts(db, input.machineId, candidate.waitingOn, fact.observedAt);
        if (
          stored.some(
            (item) =>
              item.observedAt === fact.observedAt &&
              item.updatedAt === fact.updatedAt &&
              item.mergedAt === fact.mergedAt &&
              item.state === fact.state &&
              item.value === fact.value,
          )
        ) {
          facts.push(fact);
        }
      }
      const evidence = waitEvidence(candidate, facts, now);
      if (evidence.reason === null) {
        result.unchanged++;
        result.unproven += Number(evidence.unproven);
        continue;
      }
      const next: WorkThread = {
        ...thread,
        followState: 'following',
        followRevision: thread.followRevision + 1,
        waitingFor: null,
        waitingOn: null,
        updatedAt: now,
      };
      saveThread(db, next);
      addEvent(db, next, now, 'wait-satisfied', {
        fromState: 'waiting',
        toState: 'following',
        linkKey: candidate.waitingOn.linkKey,
        reason: evidence.reason,
      });
      result.satisfied++;
    }
    return result;
  });
