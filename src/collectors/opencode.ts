import { createLocalHistoryStorage, historyPath } from '../local-history';
import { base, dominant, safeJSON } from '../text';
import type { Row } from '../types';
import { normalizeUsageRow } from '../usage-normalization';

type Agg = {
  tin: number;
  tout: number;
  tcr: number;
  tcw: number;
  reason: number;
  cost: number;
  calls: number;
  start: Date | null;
  end: Date | null;
  prov: Map<string, number>;
  model: Map<string, number>;
};

export const collectOpenCode = (storage = createLocalHistoryStorage()): Row[] => {
  const dbPath = historyPath(storage, '.local', 'share', 'opencode', 'opencode.db');
  if (!storage.exists(dbPath)) return [];

  const meta = new Map<string, { title: string; dir: string; add: number; del: number }>();
  const toolCount = new Map<string, number>();
  const turnCount = new Map<string, number>();
  const agg = new Map<string, Agg>();
  const db = storage.openDatabase(dbPath);

  try {
    for (const row of db.all('SELECT id, title, directory, summary_additions, summary_deletions FROM session')) {
      meta.set(row.id, {
        title: row.title || '',
        dir: row.directory || '',
        add: row.summary_additions || 0,
        del: row.summary_deletions || 0,
      });
    }

    for (const row of db.all(
      "SELECT session_id, count(*) n FROM part WHERE json_extract(data,'$.type')='tool' GROUP BY session_id",
    )) {
      toolCount.set(row.session_id, row.n);
    }

    for (const row of db.all('SELECT session_id, data FROM message')) {
      const data = safeJSON(row.data);
      if (data?.role === 'user') turnCount.set(row.session_id, (turnCount.get(row.session_id) || 0) + 1);
    }

    for (const row of db.all('SELECT session_id, data FROM message')) {
      const data = safeJSON(row.data);
      if (data?.role !== 'assistant') continue;
      const tokens = data.tokens;
      if (!tokens) continue;
      let current = agg.get(row.session_id);
      if (!current) {
        current = {
          tin: 0,
          tout: 0,
          tcr: 0,
          tcw: 0,
          reason: 0,
          cost: 0,
          calls: 0,
          start: null,
          end: null,
          prov: new Map(),
          model: new Map(),
        };
        agg.set(row.session_id, current);
      }
      const input = tokens.input || 0;
      const output = tokens.output || 0;
      const cacheRead = tokens.cache?.read || 0;
      const cacheWrite = tokens.cache?.write || 0;
      const reasoning = tokens.reasoning || 0;
      current.tin += input;
      current.tout += output;
      current.tcr += cacheRead;
      current.tcw += cacheWrite;
      current.reason += reasoning;
      current.cost += data.cost || 0;
      current.calls++;
      const created = data.time?.created;
      if (created) {
        const date = new Date(created);
        if (!current.start || date < current.start) current.start = date;
      }
      const completed = data.time?.completed || data.time?.created;
      if (completed) {
        const date = new Date(completed);
        if (!current.end || date > current.end) current.end = date;
      }
      const total = input + output + cacheRead + cacheWrite;
      current.prov.set(data.providerID || '?', (current.prov.get(data.providerID || '?') || 0) + total);
      current.model.set(data.modelID || '?', (current.model.get(data.modelID || '?') || 0) + total);
    }
  } finally {
    db.close();
  }

  const provLabel = (providerId: string, cost: number) => {
    if (providerId === 'openai') return cost > 0 ? 'OpenAI API' : 'Codex sub (OC)';
    if (providerId === 'anthropic') return 'Anthropic API';
    if (providerId === 'opencode') return 'OpenCode Zen';
    if (providerId === 'cursor') return 'via Cursor (OC)';
    return providerId;
  };

  const rows: Row[] = [];
  for (const [sid, current] of agg) {
    const sessionMeta = meta.get(sid);
    const providerId = dominant(current.prov);
    const model = dominant(current.model);
    const tokens = {
      in: current.tin,
      out: current.tout + current.reason,
      cr: current.tcr,
      cw: current.tcw,
    };
    const title = sessionMeta?.title && !/^ACP Session /i.test(sessionMeta.title) ? sessionMeta.title : '';
    rows.push(
      normalizeUsageRow({
        date: current.start,
        endDate: current.end,
        harness: 'OpenCode',
        provider: provLabel(providerId, current.cost),
        name: title || (sessionMeta?.title ? 'ACP session' : '') || sid.slice(0, 10),
        model: `${providerId}/${model}`,
        pricingModel: model,
        project: base(sessionMeta?.dir),
        tokens,
        costActual: current.cost,
        calls: current.calls,
        turns: turnCount.get(sid) || 0,
        tools: toolCount.get(sid) || 0,
        linesAdded: sessionMeta?.add ?? null,
        linesDeleted: sessionMeta?.del ?? null,
      }),
    );
  }
  return rows;
};
