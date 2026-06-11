import path from 'node:path';
import { harnessLabel } from '@ai-usage/core/harness-metadata';
import type { Row } from '@ai-usage/core/types';
import { actualCost, approximateApiCost, normalizeUsageRow, tokenTotal } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import { historyPath, LocalHistoryStorage, walkFiles } from '../local-history';
import { base, dominant, safeJSON, usablePrompt } from '../text';

export const collectClaude = Effect.gen(function* () {
  const storage = yield* LocalHistoryStorage;
  const dir = historyPath(storage, '.claude', 'projects');
  if (!(yield* storage.exists(dir))) return [];

  let provider = 'Claude sub';
  const cfg = historyPath(storage, '.claude.json');
  if (yield* storage.exists(cfg)) {
    const json = safeJSON(yield* storage.readText(cfg));
    if (json?.hasApiKey) provider = 'Claude API';
  }

  const files = yield* walkFiles(storage, dir, (fileName) => fileName.endsWith('.jsonl'));
  const rows: Row[] = [];
  const seen = new Set<string>();

  for (const filePath of files) {
    const isAgentFile = path.basename(filePath).startsWith('agent-');
    let title: string | null = null;
    let lastPrompt: string | null = null;
    let firstPrompt: string | null = null;
    let cwd: string | null = null;
    let start: Date | null = null;
    let end: Date | null = null;
    let calls = 0;
    let turns = 0;
    let tools = 0;
    let sidechain = isAgentFile;
    const tokens = { in: 0, out: 0, cr: 0, cw: 0 };
    const byModel = new Map<string, number>();

    for (const line of (yield* storage.readText(filePath)).split('\n')) {
      if (!line) continue;
      const event = safeJSON(line);
      if (!event) continue;
      if (event.timestamp) {
        const date = new Date(event.timestamp);
        if (Number.isFinite(date.getTime())) {
          if (!start || date < start) start = date;
          if (!end || date > end) end = date;
        }
      }
      if (event.isSidechain) sidechain = true;
      if (event.type === 'ai-title' && event.aiTitle) title = event.aiTitle;
      else if (event.type === 'last-prompt' && event.lastPrompt) lastPrompt = String(event.lastPrompt);
      else if (event.type === 'user') {
        const content = event.message?.content;
        let text: string | null = null;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          const isToolResult = content.some((block: any) => block?.type === 'tool_result');
          if (!isToolResult) text = content.find((block: any) => block?.type === 'text')?.text ?? null;
        }
        if (text) {
          turns++;
          if (!firstPrompt) firstPrompt = usablePrompt(text);
        }
      } else if (event.type === 'assistant') {
        if (event.cwd) cwd = event.cwd;
        const usage = event.message?.usage;
        if (Array.isArray(event.message?.content)) {
          tools += event.message.content.filter((block: any) => block?.type === 'tool_use').length;
        }
        if (!usage) continue;
        const id = event.message?.id;
        const key = `${id}:${event.requestId}`;
        if (id && seen.has(key)) continue;
        if (id) seen.add(key);
        calls++;
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheWrite = usage.cache_creation_input_tokens || 0;
        tokens.in += input;
        tokens.out += output;
        tokens.cr += cacheRead;
        tokens.cw += cacheWrite;
        const model = event.message?.model || 'unknown';
        byModel.set(model, (byModel.get(model) || 0) + input + output + cacheRead + cacheWrite);
      }
    }

    if (!start && tokenTotal(tokens) === 0) continue;
    const model = dominant(byModel);
    const name =
      title ||
      usablePrompt(lastPrompt) ||
      firstPrompt ||
      `${sidechain ? 'subagent ' : ''}${path.basename(filePath, '.jsonl').slice(0, 8)}`;

    rows.push(
      normalizeUsageRow({
        date: start,
        endDate: end,
        harness: harnessLabel('claude'),
        provider,
        name,
        model,
        project: base(cwd),
        tokens,
        cost: provider === 'Claude API' ? approximateApiCost : actualCost(0),
        calls,
        turns,
        tools,
        linesAdded: null,
        linesDeleted: null,
        subagent: sidechain,
      }),
    );
  }

  return rows;
});
