import path from 'node:path';
import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import type { TokenCounts } from '@ai-usage/report-core/usage-row';
import { Effect } from 'effect';
import { LocalHistoryError, type LocalHistoryWarning } from '../errors';
import { CURSOR_CSV_MAX_BYTES } from '../history-budgets';
import { LocalHistoryStorage, type LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import {
  addNonNegativeSafeIntegers,
  metricValidationWarning,
  parseNonNegativeFiniteNumber,
} from '../metric-validation';

export interface CursorCsvOptions {
  clusterGapMs: number;
  usageExportDir?: string;
  usageExportPaths?: string[];
  user?: string;
}

export interface CursorCsvCluster {
  artifactPath: string;
  calls: number;
  costActual: number;
  costApprox: number;
  costKnown: boolean;
  costQuota: number;
  dominantModel: string;
  endDate: Date;
  modelSegments: UsageModelSegment[];
  models: string[];
  startDate: Date;
  tokens: TokenCounts;
}

export interface CursorCsvTurn {
  artifactPath: string;
  costActual: number;
  costApprox: number;
  costKnown: boolean;
  costQuota: number;
  date: Date;
  model: string;
  tokens: TokenCounts;
}

export interface CursorCsvTurnsResult {
  rejectedMetricRecords: number;
  turns: CursorCsvTurn[];
  warnings: LocalHistoryWarning[];
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
    if (!(yield* storage.exists(resolvedDir).pipe(Effect.catchAll(() => Effect.succeed(false))))) {
      return [];
    }
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

const visitCsvRows = (
  storage: LocalHistoryStorageService,
  filePath: string,
  visit: (row: Record<string, string>) => void,
): Effect.Effect<void, LocalHistoryError> =>
  Effect.gen(function* () {
    let headers: string[] | null = null;
    yield* storage.readLines(
      filePath,
      (line) => {
        if (line.length === 0) {
          return;
        }
        if (headers === null) {
          headers = parseCsvLine(line);
          const missing = REQUIRED_HEADERS.filter((header) => !headers?.includes(header));
          if (missing.length) {
            throw new Error(`Missing Cursor CSV columns: ${missing.join(', ')}`);
          }
          return;
        }
        const values = parseCsvLine(line);
        const row: Record<string, string> = {};
        for (const [index, header] of headers.entries()) {
          row[header] = values[index] ?? '';
        }
        visit({ ...row, __artifactPath: filePath });
      },
      { maxBytes: CURSOR_CSV_MAX_BYTES },
    );
  });

const INTEGER_FIELD_PATTERN = /^\s*(?:\d+|\d{1,3}(?:,\d{3})+)\s*$/;
const COST_FIELD_PATTERN = /^\s*\$?\d+(?:\.\d+)?\s*$/;

const parseInteger = (value: string): number | null => {
  if (!value.trim()) {
    return 0;
  }
  if (!INTEGER_FIELD_PATTERN.test(value)) {
    return null;
  }
  const normalized = value.trim().replaceAll(',', '');
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parseCost = (value: string): number | null => {
  if (!value.trim()) {
    return 0;
  }
  if (!COST_FIELD_PATTERN.test(value)) {
    return null;
  }
  const parsed = Number(value.trim().replace('$', ''));
  const validated = parseNonNegativeFiniteNumber(parsed);
  return validated.ok ? validated.value : null;
};

const tokenTotal = (tokens: TokenCounts): number | null => {
  const input = addNonNegativeSafeIntegers(tokens.in, tokens.out);
  if (!input.ok) {
    return null;
  }
  const cache = addNonNegativeSafeIntegers(tokens.cr, tokens.cw);
  if (!cache.ok) {
    return null;
  }
  const total = addNonNegativeSafeIntegers(input.value, cache.value);
  return total.ok ? total.value : null;
};

type CursorCsvRowResult = { status: 'invalid' } | { status: 'skip' } | { status: 'valid'; turn: CursorCsvTurn };

const rowToTurn = (row: Record<string, string>, user?: string): CursorCsvRowResult => {
  if (user && row.User !== user) {
    return { status: 'skip' };
  }
  const date = new Date(row.Date ?? '');
  if (!Number.isFinite(date.getTime())) {
    return { status: 'invalid' };
  }
  const model = row.Model?.trim() || 'cursor';
  const parsedTokens = [
    parseInteger(row['Input (w/o Cache Write)'] ?? ''),
    parseInteger(row['Output Tokens'] ?? ''),
    parseInteger(row['Cache Read'] ?? ''),
    parseInteger(row['Input (w/ Cache Write)'] ?? ''),
  ];
  if (parsedTokens.some((value) => value === null)) {
    return { status: 'invalid' };
  }
  const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = parsedTokens as number[];
  const tokens = { in: input, out: output, cr: cacheRead, cw: cacheWrite };
  const total = tokenTotal(tokens);
  if (total === null || total === 0) {
    return total === null ? { status: 'invalid' } : { status: 'skip' };
  }

  const cost = parseCost(row.Cost ?? '');
  if (cost === null) {
    return { status: 'invalid' };
  }
  const kind = row.Kind ?? '';
  const isOnDemand = kind === 'On-Demand';
  const isIncluded = kind === 'Included';
  const { rates, known } = priceFor(model, { at: date });
  return {
    status: 'valid',
    turn: {
      date,
      artifactPath: row.__artifactPath ?? '',
      model,
      tokens,
      costActual: isOnDemand ? cost : 0,
      costQuota: isIncluded ? cost : 0,
      costApprox: approxCost(rates, tokens),
      costKnown: known,
    },
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
  const modelSegmentsByModel = new Map<string, UsageModelSegment>();
  const models: string[] = [];
  let tokens: TokenCounts = { in: 0, out: 0, cr: 0, cw: 0 };
  let costActual = 0;
  let costQuota = 0;
  let costApprox = 0;
  let costKnown = true;
  for (const turn of turns) {
    if (!modelTokens.has(turn.model)) {
      models.push(turn.model);
    }
    modelTokens.set(turn.model, (modelTokens.get(turn.model) ?? 0) + (tokenTotal(turn.tokens) ?? 0));
    const currentSegment = modelSegmentsByModel.get(turn.model) ?? {
      model: turn.model,
      tokIn: 0,
      tokOut: 0,
      tokCr: 0,
      tokCw: 0,
      costApprox: 0,
      costKnown: true,
    };
    modelSegmentsByModel.set(turn.model, {
      model: turn.model,
      tokIn: currentSegment.tokIn + turn.tokens.in,
      tokOut: currentSegment.tokOut + turn.tokens.out,
      tokCr: currentSegment.tokCr + turn.tokens.cr,
      tokCw: currentSegment.tokCw + turn.tokens.cw,
      costApprox: currentSegment.costApprox + turn.costApprox,
      costKnown: currentSegment.costKnown && turn.costKnown,
    });
    tokens = addTokens(tokens, turn.tokens);
    costActual += turn.costActual;
    costQuota += turn.costQuota;
    costApprox += turn.costApprox;
    costKnown = costKnown && turn.costKnown;
  }
  const dominantModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? turns[0]?.model ?? 'cursor';
  return {
    artifactPath: turns[0]?.artifactPath ?? '',
    startDate: turns[0]?.date ?? new Date(0),
    endDate: turns.at(-1)?.date ?? turns[0]?.date ?? new Date(0),
    models,
    modelSegments: [...modelSegmentsByModel.values()],
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
  if (current.length) {
    clusters.push(clusterFromTurns(current));
  }
  return clusters;
};

export const collectCursorCsvTurnsResult = (
  options: CursorCsvOptions,
): Effect.Effect<CursorCsvTurnsResult, LocalHistoryError, LocalHistoryStorageService> =>
  Effect.gen(function* () {
    const storage = yield* LocalHistoryStorage;
    const turns: CursorCsvTurn[] = [];
    const seen = new Set<string>();
    let rejectedMetricRecords = 0;
    const configuredPaths = (options.usageExportPaths ?? []).map(resolveExportPath);
    const dirPaths = options.usageExportDir ? yield* exportPathsFromDir(storage, options.usageExportDir) : [];
    for (const filePath of [...configuredPaths, ...dirPaths]) {
      if (!(yield* storage.exists(filePath).pipe(Effect.catchAll(() => Effect.succeed(false))))) {
        continue;
      }
      yield* visitCsvRows(storage, filePath, (row) => {
        const parsed = rowToTurn(row, options.user);
        if (parsed.status === 'invalid') {
          rejectedMetricRecords++;
          return;
        }
        if (parsed.status === 'skip') {
          return;
        }
        const { turn } = parsed;
        const key = `${turn.date.toISOString()}|${turn.model}|${tokenTotal(turn.tokens)}|${turn.costActual}|${turn.costQuota}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        turns.push(turn);
      }).pipe(Effect.mapError((error) => csvError('parseCursorCsv', filePath, error)));
    }
    const warning = metricValidationWarning('cursor', rejectedMetricRecords);
    return {
      rejectedMetricRecords,
      turns: turns.sort((a, b) => a.date.getTime() - b.date.getTime()),
      warnings: warning ? [warning] : [],
    };
  });

export const collectCursorCsvTurns = (
  options: CursorCsvOptions,
): Effect.Effect<CursorCsvTurn[], LocalHistoryError, LocalHistoryStorageService> =>
  collectCursorCsvTurnsResult(options).pipe(Effect.map((result) => result.turns));
