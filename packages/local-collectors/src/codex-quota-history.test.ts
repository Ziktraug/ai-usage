import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect } from 'effect';
import { collectCodexRolloutQuotaBatch } from './codex-quota-history';
import { createLocalHistoryStorage, LocalHistoryStorage } from './local-history';

const event = (timestamp: string, usedPercent: number): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: '2026-07-15T15:00:00.000Z',
        },
      },
    },
  });

describe('Codex rollout quota backfill', () => {
  test('resumes from a committed byte cursor and leaves partial lines unread', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-quota-history-'));
    const sessions = path.join(home, '.codex', 'sessions', '2026', '07', '15');
    mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, 'rollout.jsonl');
    const firstLine = event('2026-07-15T10:00:00.000Z', 20);
    const secondLine = event('2026-07-15T10:10:00.000Z', 30);
    writeFileSync(rollout, `${firstLine}\n${secondLine.slice(0, 40)}`);
    const storage = createLocalHistoryStorage(home);

    const first = await Effect.runPromise(
      collectCodexRolloutQuotaBatch({
        from: new Date('2026-07-01T00:00:00.000Z'),
        machineId: 'machine-1',
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );
    expect(first.observations).toHaveLength(1);
    const cursor = first.checkpoints[0];
    expect(cursor?.key).toBe(rollout);

    writeFileSync(rollout, `${firstLine}\n${secondLine}\n`);
    const second = await Effect.runPromise(
      collectCodexRolloutQuotaBatch({
        cursors: cursor ? { [cursor.key]: cursor.value } : {},
        from: new Date('2026-07-01T00:00:00.000Z'),
        machineId: 'machine-1',
      }).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(second.observations.map(({ observedAt }) => observedAt)).toEqual(['2026-07-15T10:10:00.000Z']);
    expect(second.sourceEvents).toHaveLength(1);
  });

  test('commits complete lines when a bounded range ends inside a multibyte character', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'ai-usage-codex-quota-utf8-'));
    const sessions = path.join(home, '.codex', 'sessions', '2026', '07', '15');
    mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, 'rollout.jsonl');
    const completeLine = event('2026-07-15T10:00:00.000Z', 20);
    const incompleteLine = JSON.stringify({ message: 'é', type: 'diagnostic' });
    const completePrefix = `${completeLine}\n${incompleteLine.slice(0, incompleteLine.indexOf('é'))}`;
    writeFileSync(rollout, `${completeLine}\n${incompleteLine}\n`);
    const storage = createLocalHistoryStorage(home);

    const result = await Effect.runPromise(
      collectCodexRolloutQuotaBatch(
        {
          from: new Date('2026-07-01T00:00:00.000Z'),
          machineId: 'machine-1',
        },
        { maximumBytes: Buffer.byteLength(completePrefix) + 1, maximumFiles: 1 },
      ).pipe(Effect.provideService(LocalHistoryStorage, storage)),
    );

    expect(result.observations).toHaveLength(1);
    expect(result.checkpoints[0]).toEqual({
      key: rollout,
      value: expect.objectContaining({ offset: Buffer.byteLength(`${completeLine}\n`) }),
    });
    expect(result.hasMore).toBe(true);
  });
});
