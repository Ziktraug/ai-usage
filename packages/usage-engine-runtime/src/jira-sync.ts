import { discoverChangedJiraIssues, JIRA_CHANGE_SEARCH_KEYS } from '@ai-usage/local-collectors/jira-issue-discovery';
import { JIRA_ISSUE_DEFAULTS } from '@ai-usage/local-collectors/jira-issues';
import type { BoundedProcessRunner } from '@ai-usage/local-machine/bounded-process';
import { getCollectionSourceDefinition, type SourceWarning } from '@ai-usage/report-core/source-control';
import {
  MAX_WORK_FACT_QUERY_LIMIT,
  queryJiraSyncState,
  queryLatestJiraIssueObservations,
  recordJiraSyncState,
} from '@ai-usage/usage-store/writer';
import { Effect } from 'effect';

const FULL_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A successful search and its pending details are committed together before reading details.
 * A restart can repeat work, but cannot skip a change whose details were not stored. */
export const prepareJiraSync = (input: {
  readonly dbPath: string;
  readonly machineId: string;
  readonly candidates: readonly string[];
  readonly now: Date;
  readonly completeCandidates: boolean;
  readonly run?: BoundedProcessRunner;
  readonly signal?: AbortSignal;
}) =>
  Effect.gen(function* () {
    const previous = yield* queryJiraSyncState(input).pipe(
      Effect.catch((error) => (error.reason === 'store-missing' ? Effect.succeed(null) : Effect.fail(error))),
    );
    const allCandidates = [
      ...new Set([
        ...(previous?.pendingKeys ?? []),
        ...input.candidates,
        ...(input.completeCandidates ? [] : (previous?.knownKeys ?? [])),
      ]),
    ];
    const candidates = allCandidates.slice(0, MAX_WORK_FACT_QUERY_LIMIT);
    const latest =
      previous === null || candidates.length === 0
        ? { items: [] }
        : yield* queryLatestJiraIssueObservations({
            dbPath: input.dbPath,
            machineId: input.machineId,
            keys: candidates,
            limit: MAX_WORK_FACT_QUERY_LIMIT,
          });
    const observed = new Set(
      latest.items.filter((item) => item.latest.outcome === 'observed').map((item) => item.latest.key),
    );
    const missing = candidates.filter((key) => !(observed.has(key) && previous?.knownKeys.includes(key)));
    const failedKeys = new Set(
      latest.items.filter((item) => item.latest.outcome !== 'observed').map((item) => item.latest.key),
    );
    const unattempted = previous?.pendingKeys.filter((key) => !failedKeys.has(key)) ?? [];

    const warnings: SourceWarning[] =
      allCandidates.length > candidates.length
        ? [
            {
              code: 'jira-scope-truncated',
              message: 'Jira synchronization scope exceeds 500 tickets; additional tickets may be omitted.',
            },
          ]
        : [];
    let state = previous;
    if (
      previous &&
      previous.pendingKeys.length > 0 &&
      input.now.getTime() >= Date.parse(previous.checkedThrough) &&
      input.now.getTime() - Date.parse(previous.checkedThrough) < getCollectionSourceDefinition('jira.issues').cadenceMs
    ) {
      state = { ...previous, knownKeys: candidates, pendingKeys: [...new Set([...previous.pendingKeys, ...missing])] };
    } else {
      const now = input.now.toISOString();
      const full =
        previous === null ||
        input.now.getTime() < Date.parse(previous.checkedThrough) ||
        input.now.getTime() < Date.parse(previous.fullScanAt) ||
        input.now.getTime() - Date.parse(previous.fullScanAt) >= FULL_CHECK_INTERVAL_MS;
      const changed: string[] = [];
      if (!full) {
        for (let start = 0; start < candidates.length; start += JIRA_CHANGE_SEARCH_KEYS) {
          const result = yield* discoverChangedJiraIssues({
            keys: candidates.slice(start, start + JIRA_CHANGE_SEARCH_KEYS),
            since: previous.checkedThrough,
            now: input.now,
            ...(input.run ? { run: input.run } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.outcome !== 'observed' || result.truncated) {
            warnings.push({
              code: `jira-changes-${result.truncated ? 'truncated' : result.outcome}`,
              message:
                result.outcomeMessage ?? 'Jira change search was incomplete; the last complete checkpoint is retained.',
            });
            break;
          }
          changed.push(...result.keys);
        }
      }
      state = {
        knownKeys: candidates,
        checkedThrough: warnings.length === 0 ? now : (previous?.checkedThrough ?? now),
        fullScanAt: full ? now : (previous?.fullScanAt ?? now),
        pendingKeys: [
          ...new Set([
            ...(full ? candidates : unattempted),
            ...changed.filter((key) => !failedKeys.has(key)),
            ...missing.filter((key) => !failedKeys.has(key)),
            ...(previous?.pendingKeys ?? []),
            ...changed,
            ...missing,
          ]),
        ].filter((key) => candidates.includes(key)),
      };
    }
    // Persist before a detail read: even a killed run resumes this exact backlog.
    yield* recordJiraSyncState({ ...input, state });
    return { state, keys: state.pendingKeys.slice(0, JIRA_ISSUE_DEFAULTS.maxKeys), warnings };
  });
