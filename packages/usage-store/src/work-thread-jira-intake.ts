import type { CanonicalInstant } from '@ai-usage/report-core/canonical-instant';
import { jiraIssueLinkKey, parseWorkThreadLinkKey } from '@ai-usage/report-core/work-thread';
import type { Effect } from 'effect';
import type { UsageStoreError } from './errors';
import { jiraKeyFollowers } from './work-thread-combination';
import { instant, invalidInput, read, record, write } from './work-thread-rows';

interface RecordJiraIntakeInput {
  /** Only a complete search proves that an issue absent from it is no longer assigned. */
  readonly complete: boolean;
  readonly dbPath: string;
  /** Issue keys (`XYZ-1`) the assigned-issue search returned this run. */
  readonly keys: readonly string[];
  readonly machineId: string;
  readonly now: string;
}

interface QueryJiraIntakeInput {
  readonly dbPath: string;
  readonly limit: number;
  readonly machineId: string;
}

interface JiraIntakeEntry {
  readonly firstSeenAt: CanonicalInstant;
  /** `jira:<site>/<KEY>` */
  readonly key: string;
}

interface QueryJiraIntakeResult {
  readonly items: readonly JiraIntakeEntry[];
  readonly truncated: boolean;
}

const MAX_JIRA_INTAKE_KEYS = 500;

/** Assignment is recorded, never turned into a task: the operator chooses what to follow. */
export const recordJiraIntake = (input: RecordJiraIntakeInput): Effect.Effect<number, UsageStoreError> =>
  write(input.dbPath, 'recordJiraIntake', (db) => {
    const now = instant(input.now);
    if (input.keys.length > MAX_JIRA_INTAKE_KEYS) {
      return invalidInput('Too many assigned Jira issues for one intake record');
    }
    const keys = [...new Set(input.keys)].map((key) => jiraIssueLinkKey({ key, site: 'default' }));
    if (keys.some((key) => !parseWorkThreadLinkKey('jira-issue', key))) {
      return invalidInput('Assigned Jira issues must be qualified keys');
    }
    for (const key of keys) {
      db.query(`INSERT INTO work_jira_intake(machine_id, link_key, first_seen_at, assigned, assigned_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(machine_id, link_key) DO UPDATE SET assigned = 1, assigned_at = excluded.assigned_at`).run(
        input.machineId,
        key,
        now,
        now,
      );
    }
    if (input.complete) {
      db.query(
        `UPDATE work_jira_intake SET assigned = 0 WHERE machine_id = ? AND assigned = 1
          AND link_key NOT IN (SELECT value FROM json_each(?))`,
      ).run(input.machineId, JSON.stringify(keys));
    }
    return keys.length;
  });

/** Assigned, undismissed issues that no open task follows, newest assignment first. */
export const queryJiraIntake = (input: QueryJiraIntakeInput): Effect.Effect<QueryJiraIntakeResult, UsageStoreError> =>
  read(input.dbPath, 'queryJiraIntake', (db) => {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_JIRA_INTAKE_KEYS) {
      return invalidInput('Invalid Jira intake limit');
    }
    const rows = db
      .query(
        `SELECT link_key, first_seen_at FROM work_jira_intake
          WHERE machine_id = ? AND assigned = 1 AND dismissed_at IS NULL
          ORDER BY first_seen_at DESC, link_key LIMIT ?`,
      )
      .all(input.machineId, MAX_JIRA_INTAKE_KEYS + 1);
    const items: JiraIntakeEntry[] = [];
    for (const row of rows.slice(0, MAX_JIRA_INTAKE_KEYS)) {
      const value = record(row);
      const key = String(value.link_key);
      if (jiraKeyFollowers(db, input.machineId, key).open.length === 0) {
        items.push({ firstSeenAt: instant(String(value.first_seen_at)), key });
      }
    }
    return {
      items: items.slice(0, input.limit),
      truncated: items.length > input.limit || rows.length > MAX_JIRA_INTAKE_KEYS,
    };
  });
