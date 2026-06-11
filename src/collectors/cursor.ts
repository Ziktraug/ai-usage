import { Effect } from 'effect';
import { harnessLabel } from '../harness-metadata';
import { historyPath, LocalHistoryStorage } from '../local-history';
import { safeJSON, usablePrompt } from '../text';
import type { Row } from '../types';
import { actualCost, normalizeUsageRow } from '../usage-row';

type KeyValueRow = { key: string; value: string };

const COMPOSER_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'";
const TOKEN_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"inputTokens\"%'";
const USER_BUBBLE_SQL = "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE '%\"type\":1%'";

export const collectCursor = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dbPath = historyPath(
    storage,
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
  if (!(yield* storage.exists(dbPath))) return [];

  const comp = new Map<string, { name: string; model: string; created: number; add: number; del: number }>();
  const agg = new Map<string, { in: number; out: number; cr: number; cw: number; calls: number }>();
  const naming = new Map<string, { turns: number; first: string | null }>();

  yield* Effect.acquireUseRelease(
    storage.openDatabase(dbPath),
    (db) =>
      Effect.gen(function* () {
        for (const row of yield* db.all<KeyValueRow>(COMPOSER_SQL)) {
          const id = row.key.slice('composerData:'.length);
          const data = safeJSON(row.value);
          if (!data) continue;
          comp.set(id, {
            name: data.name || '',
            model: data.modelConfig?.modelName || data.modelConfig?.model || 'cursor',
            created: data.createdAt || 0,
            add: data.totalLinesAdded || 0,
            del: data.totalLinesRemoved || 0,
          });
        }

        for (const row of yield* db.all<KeyValueRow>(TOKEN_SQL)) {
          const parts = String(row.key).split(':');
          const composerId = parts[1];
          const data = safeJSON(row.value);
          const tokenCount = data?.tokenCount;
          if (!tokenCount || !composerId) continue;
          const input = tokenCount.inputTokens || 0;
          const output = tokenCount.outputTokens || 0;
          const cacheRead = tokenCount.cacheReadTokens || 0;
          const cacheWrite = tokenCount.cacheWriteTokens || 0;
          if (input + output + cacheRead + cacheWrite === 0) continue;
          let current = agg.get(composerId);
          if (!current) {
            current = { in: 0, out: 0, cr: 0, cw: 0, calls: 0 };
            agg.set(composerId, current);
          }
          current.in += input;
          current.out += output;
          current.cr += cacheRead;
          current.cw += cacheWrite;
          current.calls++;
        }

        const wantedComposerIds = new Set(agg.keys());
        for (const row of yield* db.all<KeyValueRow>(USER_BUBBLE_SQL)) {
          const composerId = String(row.key).split(':')[1];
          if (!composerId || !wantedComposerIds.has(composerId)) continue;
          const data = safeJSON(row.value);
          if (data?.type !== 1) continue;
          const current = naming.get(composerId) ?? { turns: 0, first: null };
          current.turns++;
          if (!current.first) current.first = usablePrompt(data.text);
          naming.set(composerId, current);
        }
      }),
    (db) => db.close,
  );

  const rows: Row[] = [];
  for (const [composerId, current] of agg) {
    const composer = comp.get(composerId);
    const name = naming.get(composerId);
    const model = composer?.model || 'cursor';
    const tokens = {
      in: current.in,
      out: current.out,
      cr: current.cr,
      cw: current.cw,
    };
    rows.push(
      normalizeUsageRow({
        date: composer?.created ? new Date(composer.created) : null,
        endDate: null,
        harness: harnessLabel('cursor'),
        provider: 'Cursor sub',
        name: composer?.name || name?.first || `cursor ${composerId.slice(0, 8)}`,
        model,
        project: '',
        tokens,
        cost: actualCost(0),
        calls: current.calls,
        turns: name?.turns || 0,
        tools: 0,
        linesAdded: composer?.add ?? null,
        linesDeleted: composer?.del ?? null,
        partial: true,
      }),
    );
  }
  return rows;
});
