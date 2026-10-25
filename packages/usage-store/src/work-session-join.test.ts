import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';
import { UsageStoreError } from './errors';
import { createWorkSessionJoinStore, MAX_WORK_HARNESS_SESSION_MEMBERS } from './work-session-join';

const fixture = (count: number) => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE served_report_rows (
      revision TEXT, ordinal INTEGER, row_id TEXT, campaign_key TEXT, campaign_root INTEGER,
      campaign_total_count INTEGER, project_label TEXT, machine_id TEXT, origin TEXT,
      active_time INTEGER, source_row_json TEXT, PRIMARY KEY (revision, ordinal)
    );
    CREATE INDEX idx_served_report_rows_campaign ON served_report_rows(revision, campaign_key, campaign_root, ordinal);
    CREATE INDEX idx_served_report_rows_active_time ON served_report_rows(revision, active_time);
    CREATE TABLE served_report_revisions (revision TEXT, generated_at TEXT, complete INTEGER);
    CREATE TABLE served_report_current (singleton INTEGER, revision TEXT);
    INSERT INTO served_report_revisions VALUES ('revision', '2026-10-22T12:00:00.000Z', 1);
    INSERT INTO served_report_current VALUES (1, 'revision');
  `);
  const insert = db.query('INSERT INTO served_report_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let index = 0; index < count; index++) {
      insert.run(
        'revision',
        index,
        `row-${index}`,
        'campaign',
        Number(index === 0),
        index === 0 ? count : null,
        'project',
        'machine',
        index === 0 ? 'human' : 'subagent',
        index + 1,
        JSON.stringify({
          date: '2026-10-22T12:00:00.000Z',
          sessionLabel: `Session ${index}`,
          source: {
            harnessKey: 'codex',
            sourceSessionId: `session-${index}`,
            parentSourceSessionId: index === 0 ? null : 'session-0',
            sourcePath: '/fixture/project',
            vcs: { branches: [{ name: 'fixture' }] },
          },
          description: 'Synthetic publication payload. '.repeat(100),
        }),
      );
    }
  })();
  db.exec('PRAGMA query_only = ON');
  const store = createWorkSessionJoinStore({
    usageStoreError: (operation, _dbPath, cause, reason) =>
      new UsageStoreError({ operation, message: String(cause), reason }),
    usageStoreReadError: (operation, _dbPath, cause) =>
      new UsageStoreError({ operation, message: String(cause), reason: 'storage-failure' }),
    // Bun 1.4 types `query` bindings more narrowly than the store's structural reader seam.
    withUsageStoreReader: (_dbPath, use) => use(db as unknown as Parameters<typeof use>[0]),
  });
  return { db, store };
};

describe('bounded served campaign members', () => {
  test('keeps root, exact count and declared parents in a 20,000-member campaign', async () => {
    const { db, store } = fixture(20_000);
    try {
      const times: number[] = [];
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        const read = await Effect.runPromise(
          store.queryRecentServedHarnessSessions({ activeSince: 0, dbPath: ':memory:', harnessKey: 'codex' }),
        );
        times.push(performance.now() - start);
        expect(read.familiesInWindow).toBe(1);
        expect(read.families[0]?.memberCount).toBe(20_000);
        const members = read.families[0]?.members ?? [];
        expect(members).toHaveLength(MAX_WORK_HARNESS_SESSION_MEMBERS + 1);
        expect(members.map((member) => member.sourceSessionId)).toEqual([
          'session-0',
          'session-19999',
          'session-19998',
          'session-19997',
          'session-19996',
          'session-19995',
        ]);
        expect(members.slice(1).every((member) => member.parentSourceSessionId === 'session-0')).toBe(true);
      }
      console.info(`20k Work campaign query ms: ${times.map((value) => value.toFixed(1)).join(', ')}`);
    } finally {
      db.close();
    }
  });
});
