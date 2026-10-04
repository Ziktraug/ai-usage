import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONTINUITY_CAMPAIGN_COUNT = 160;
export const CONTINUITY_CHILD_COUNT = 360;
export const CONTINUITY_ROOT_ID = 'continuity-root';
export const CONTINUITY_ROOT_TITLE = 'Continuity root';
export const CONTINUITY_HOME_RECORD_ENV = 'AI_USAGE_CAMPAIGN_CONTINUITY_HOME_RECORD';
export const DETAIL_EXPLORATION_COUNT = 420;
export const DETAIL_EXPLORATION_TITLE = 'Detail exploration';

interface ContinuitySession {
  readonly id: string;
  readonly parent?: string;
  readonly project: number;
  readonly start: number;
  readonly title: string;
}

const writeSession = async (directory: string, session: ContinuitySession): Promise<void> => {
  const instant = (offset: number): string => new Date(session.start + offset).toISOString();
  const events = [
    {
      timestamp: instant(0),
      type: 'session_meta',
      payload: {
        id: session.id,
        cwd: `/work/continuity-project-${session.project}`,
        ...(session.parent ? { source: { subagent: { thread_spawn: { parent_thread_id: session.parent } } } } : {}),
      },
    },
    { timestamp: instant(1), type: 'event_msg', payload: { type: 'task_started', turn_id: `${session.id}-turn` } },
    { timestamp: instant(1), type: 'turn_context', payload: { model: 'gpt-5.6-sol', turn_id: `${session.id}-turn` } },
    { timestamp: instant(2), type: 'event_msg', payload: { type: 'user_message', message: session.title } },
    {
      timestamp: instant(60_000),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 25,
            output_tokens: 20,
            reasoning_output_tokens: 0,
            total_tokens: 120,
          },
        },
      },
    },
    {
      timestamp: instant(90_000),
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: `${session.id}-turn`, duration_ms: 90_000 },
    },
  ];
  await writeFile(
    join(directory, `${session.id}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
};

const writeNativeChildLinks = (fixtureHome: string, sessions: readonly ContinuitySession[]): void => {
  // The report projection reads JSONL parent metadata; the local detail reader
  // discovers children from native Codex edges. Seed both representations of
  // the same lineage, without claiming which prompt spawned a child.
  const database = new Database(join(fixtureHome, '.codex', 'state_5.sqlite'), { create: true });
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT, title TEXT, first_user_message TEXT,
        source TEXT, thread_source TEXT, model TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    `);
    const insertThread = database.query(`
      INSERT INTO threads (id, cwd, title, first_user_message, source, thread_source, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEdge = database.query('INSERT INTO thread_spawn_edges VALUES (?, ?)');
    database.transaction(() => {
      for (const session of sessions) {
        insertThread.run(
          session.id,
          `/work/continuity-project-${session.project}`,
          session.title,
          session.title,
          session.parent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: session.parent } } }) : 'cli',
          session.parent ? 'subagent' : null,
          'gpt-5.6-sol',
          Math.floor(session.start / 1000),
          Math.floor((session.start + 90_000) / 1000),
        );
        if (session.parent) {
          insertEdge.run(session.parent, session.id);
        }
      }
    })();
  } finally {
    database.close();
  }
};

/** Only called with production-server's freshly created, isolated harness home. */
export const seedCampaignContinuity = async (fixtureHome: string): Promise<void> => {
  const directory = join(fixtureHome, '.codex', 'sessions', '2026', '07');
  await mkdir(directory, { recursive: true });
  const lineage: ContinuitySession[] = [];
  const writeLineageSession = async (session: ContinuitySession): Promise<void> => {
    lineage.push(session);
    await writeSession(directory, session);
  };
  await writeLineageSession({
    id: CONTINUITY_ROOT_ID,
    project: 0,
    start: Date.parse('2026-07-03T11:00:00.000Z'),
    title: CONTINUITY_ROOT_TITLE,
  });
  for (let index = 0; index < CONTINUITY_CHILD_COUNT; index++) {
    await writeLineageSession({
      id: `continuity-child-${String(index).padStart(4, '0')}`,
      // A later page brings this node's parent, exercising a changed hierarchy projection.
      parent: index === 13 ? 'continuity-child-0250' : CONTINUITY_ROOT_ID,
      project: 0,
      start: Date.parse('2026-07-03T08:00:00.000Z') + index * 20_000,
      title: `Continuity child ${String(index).padStart(4, '0')}${index % 13 === 0 ? ' with a deliberately long title to exercise responsive row measurement and anchor preservation' : ''}`,
    });
  }
  writeNativeChildLinks(fixtureHome, lineage);
  for (let index = 1; index < CONTINUITY_CAMPAIGN_COUNT; index++) {
    await writeSession(directory, {
      id: `continuity-campaign-${String(index).padStart(4, '0')}`,
      project: index % 12,
      start: Date.parse('2026-07-02T23:00:00.000Z') - index * 60_000,
      title: `Continuity campaign ${String(index).padStart(4, '0')}`,
    });
  }
  // Separate search scope: exercise three real Sessions pages without changing
  // the 160-campaign/360-child Continuity journeys or their identity assertions.
  for (let index = 0; index < DETAIL_EXPLORATION_COUNT; index++) {
    await writeSession(directory, {
      id: `detail-exploration-${String(index).padStart(4, '0')}`,
      project: 20,
      start: Date.parse('2026-07-01T12:00:00.000Z') - index * 60_000,
      title: `${DETAIL_EXPLORATION_TITLE} ${String(index).padStart(4, '0')}`,
    });
  }
};

/** Source input for an actual engine publication; never opens either SQLite store. */
export const addCampaignContinuityRevision = async (fixtureHome: string, batch = 'new'): Promise<void> => {
  const directory = join(fixtureHome, '.codex', 'sessions', '2026', '07');
  for (let index = 0; index < 45; index++) {
    await writeSession(directory, {
      id: `continuity-${batch}-campaign-${index}`,
      project: index % 12,
      start: Date.parse('2026-07-03T11:30:00.000Z') + index * 1000,
      title: `Continuity ${batch} campaign ${index}`,
    });
  }
};
