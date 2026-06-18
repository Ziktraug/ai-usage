import path from 'node:path';
import { approxCost, priceFor } from '@ai-usage/core/pricing';
import type { TokenCounts } from '@ai-usage/core/usage-row';
import { Effect } from 'effect';
import { LocalHistoryError } from '../errors';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';

export interface CursorCsvOptions {
  usageExportPaths?: string[];
  usageExportDir?: string;
  clusterGapMs: number;
  user?: string;
}

export interface CursorCsvCluster {
  startDate: Date;
  endDate: Date;
  sourcePath: string;
  models: string[];
  dominantModel: string;
  tokens: TokenCounts;
  calls: number;
  costActual: number;
  costQuota: number;
  costApprox: number;
  costKnown: boolean;
}

export interface CursorCsvTurn {
  date: Date;
  sourcePath: string;
  model: string;
  tokens: TokenCounts;
  costActual: number;
  costQuota: number;
  costApprox: number;
  costKnown: boolean;
}

const REQUIRED_HEADERS = [
  'Date',
  'User',
  'Kind',
  'Model',
  'Input (w/ Cache Write)',
  'Input (w/o Cache Write)',
  'Cache Read',
  'Output Tokens',
  'Cost',
];

const csvError = (operation: string, filePath: string, cause: unknown) =>
  new LocalHistoryError({ operation, path: filePath, cause });

const resolveExportPath = (exportPath: string) => path.resolve(exportPath);

const exportPathsFromDir = (
  storage: LocalHistoryStorageService,
  dirPath: string,
): Effect.Effect<string[], LocalHistoryError> =>
  Effect.gen(function* () {
    const resolvedDir = resolveExportPath(dirPath);
    if (!(yield* storage.exists(resolvedDir).pipe(Effect.catchAll(() => Effect.succeed(false))))) return [];
    const entries = yield* storage.readDir(resolvedDir);
    return entries
      .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith('.csv'))
      .map((entry) => path.join(resolvedDir, entry.name));
  });

const parseCsvLine = (line: string): string[] => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
};

const parseCsv = (text: string, filePath: string) => {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0] ?? '');
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`Missing Cursor CSV columns: ${missing.join(', ')}`);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });
    return { ...row, __sourcePath: filePath };
  });
};

const parseInteger = (value: string) => {
  const normalized = value.trim().replaceAll(',', '');
  if (!normalized) return 0;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const parseCost = (value: string) => {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const tokenTotal = (tokens: TokenCounts) => tokens.in + tokens.out + tokens.cr + tokens.cw;

const rowToTurn = (row: Record<string, string>, user?: string): CursorCsvTurn | null => {
  if (user && row.User !== user) return null;
  const date = new Date(row.Date ?? '');
  if (!Number.isFinite(date.getTime())) return null;
  const model = row.Model?.trim() || 'cursor';
  const tokens = {
    in: parseInteger(row['Input (w/o Cache Write)'] ?? ''),
    out: parseInteger(row['Output Tokens'] ?? ''),
    cr: parseInteger(row['Cache Read'] ?? ''),
    cw: parseInteger(row['Input (w/ Cache Write)'] ?? ''),
  };
  if (tokenTotal(tokens) === 0) return null;

  const cost = parseCost(row.Cost ?? '');
  const kind = row.Kind ?? '';
  const isOnDemand = kind === 'On-Demand';
  const isIncluded = kind === 'Included';
  const { rates, known } = priceFor(model);
  return {
    date,
    sourcePath: row.__sourcePath ?? '',
    model,
    tokens,
    costActual: isOnDemand ? cost : 0,
    costQuota: isIncluded ? cost : 0,
    costApprox: approxCost(rates, tokens),
    costKnown: known,
  };
};

const addTokens = (left: TokenCounts, right: TokenCounts): TokenCounts => ({
  in: left.in + right.in,
  out: left.out + right.out,
  cr: left.cr + right.cr,
  cw: left.cw + right.cw,
});

export const clusterFromTurns = (turns: CursorCsvTurn[]): CursorCsvCluster => {
  const modelTokens = new Map<string, number>();
  const models: string[] = [];
  let tokens: TokenCounts = { in: 0, out: 0, cr: 0, cw: 0 };
  let costActual = 0;
  let costQuota = 0;
  let costApprox = 0;
  let costKnown = true;
  for (const turn of turns) {
    if (!modelTokens.has(turn.model)) models.push(turn.model);
    modelTokens.set(turn.model, (modelTokens.get(turn.model) ?? 0) + tokenTotal(turn.tokens));
    tokens = addTokens(tokens, turn.tokens);
    costActual += turn.costActual;
    costQuota += turn.costQuota;
    costApprox += turn.costApprox;
    costKnown = costKnown && turn.costKnown;
  }
  const dominantModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? turns[0]?.model ?? 'cursor';
  return {
    startDate: turns[0]?.date ?? new Date(0),
    endDate: turns.at(-1)?.date ?? turns[0]?.date ?? new Date(0),
    sourcePath: turns[0]?.sourcePath ?? '',
    models,
    dominantModel,
    tokens,
    calls: turns.length,
    costActual,
    costQuota,
    costApprox,
    costKnown,
  };
};

export const clusterTurns = (turns: CursorCsvTurn[], clusterGapMs: number): CursorCsvCluster[] => {
  const sorted = [...turns].sort((a, b) => a.date.getTime() - b.date.getTime());
  const clusters: CursorCsvCluster[] = [];
  let current: CursorCsvTurn[] = [];
  for (const turn of sorted) {
    const previous = current.at(-1);
    if (previous && turn.date.getTime() - previous.date.getTime() > clusterGapMs) {
      clusters.push(clusterFromTurns(current));
      current = [];
    }
    current.push(turn);
  }
  if (current.length) clusters.push(clusterFromTurns(current));
  return clusters;
};

export const collectCursorCsvTurns = (
  options: CursorCsvOptions,
): Effect.Effect<CursorCsvTurn[], LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const turns: CursorCsvTurn[] = [];
    const seen = new Set<string>();
    const configuredPaths = (options.usageExportPaths ?? []).map(resolveExportPath);
    const dirPaths = options.usageExportDir ? yield* exportPathsFromDir(storage, options.usageExportDir) : [];
    for (const filePath of [...configuredPaths, ...dirPaths]) {
      if (!(yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false))))) continue;
      const text = yield* storage.readText(filePath);
      const rows = yield* Effect.try({
        try: () => parseCsv(text, filePath),
        catch: (cause) => csvError('parseCursorCsv', filePath, cause),
      });
      for (const row of rows) {
        const turn = rowToTurn(row, options.user);
        if (!turn) continue;
        const key = `${turn.date.toISOString()}|${turn.model}|${tokenTotal(turn.tokens)}|${turn.costActual}|${turn.costQuota}`;
        if (seen.has(key)) continue;
        seen.add(key);
        turns.push(turn);
      }
    }
    return turns.sort((a, b) => a.date.getTime() - b.date.getTime());
  });
