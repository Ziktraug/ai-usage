import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONTINUITY_CAMPAIGN_COUNT = 160;
export const CONTINUITY_CHILD_COUNT = 360;
export const CONTINUITY_ROOT_ID = 'continuity-root';
export const CONTINUITY_ROOT_TITLE = 'Continuity root';
export const CONTINUITY_HOME_RECORD_ENV = 'AI_USAGE_CAMPAIGN_CONTINUITY_HOME_RECORD';

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

/** Only called with production-server's freshly created, isolated harness home. */
export const seedCampaignContinuity = async (fixtureHome: string): Promise<void> => {
  const directory = join(fixtureHome, '.codex', 'sessions', '2026', '07');
  await mkdir(directory, { recursive: true });
  await writeSession(directory, {
    id: CONTINUITY_ROOT_ID,
    project: 0,
    start: Date.parse('2026-07-03T11:00:00.000Z'),
    title: CONTINUITY_ROOT_TITLE,
  });
  for (let index = 0; index < CONTINUITY_CHILD_COUNT; index++) {
    await writeSession(directory, {
      id: `continuity-child-${String(index).padStart(4, '0')}`,
      // A later page brings this node's parent, exercising a changed hierarchy projection.
      parent: index === 13 ? 'continuity-child-0250' : CONTINUITY_ROOT_ID,
      project: 0,
      start: Date.parse('2026-07-03T08:00:00.000Z') + index * 20_000,
      title: `Continuity child ${String(index).padStart(4, '0')}${index % 13 === 0 ? ' with a deliberately long title to exercise responsive row measurement and anchor preservation' : ''}`,
    });
  }
  for (let index = 1; index < CONTINUITY_CAMPAIGN_COUNT; index++) {
    await writeSession(directory, {
      id: `continuity-campaign-${String(index).padStart(4, '0')}`,
      project: index % 12,
      start: Date.parse('2026-07-02T23:00:00.000Z') - index * 60_000,
      title: `Continuity campaign ${String(index).padStart(4, '0')}`,
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
