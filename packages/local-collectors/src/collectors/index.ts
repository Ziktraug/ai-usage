import { HARNESS_METADATA, type HarnessKey, type HarnessMetadata, harnessKeys } from '@ai-usage/core/harness-metadata';
import type { Row } from '@ai-usage/core/types';
import { Effect } from 'effect';
import type { LocalHistoryError } from '../errors';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import { enrichCollectorRowsWithRtkSavings, stripCollectorMetadata } from '../rtk-enrichment';
import { collectClaude } from './claude';
import { collectCodex } from './codex';
import { collectCursor } from './cursor';
import { collectOpenCode } from './opencode';

export interface HarnessAdapter {
  metadata: HarnessMetadata;
  collect: Effect.Effect<Row[], LocalHistoryError, LocalHistoryStorageService>;
}

export interface HarnessSelection {
  harness: HarnessKey | null;
  includeCursor: boolean;
}

export const HARNESS_ADAPTERS: Record<HarnessKey, HarnessAdapter> = {
  claude: { metadata: HARNESS_METADATA.claude, collect: collectClaude },
  codex: { metadata: HARNESS_METADATA.codex, collect: collectCodex },
  opencode: { metadata: HARNESS_METADATA.opencode, collect: collectOpenCode },
  cursor: { metadata: HARNESS_METADATA.cursor, collect: collectCursor },
};

export const selectedHarnessAdapters = (selection: HarnessSelection) => {
  const keys = selection.harness ? [selection.harness] : harnessKeys;
  return keys.filter((key) => selection.includeCursor || key !== 'cursor').map((key) => HARNESS_ADAPTERS[key]);
};

export const collectSelectedHarnessRows = (selection: HarnessSelection) =>
  Effect.gen(function* () {
    const effects = selectedHarnessAdapters(selection).map((adapter) => adapter.collect);
    const rows = (yield* Effect.all(effects, { concurrency: 'unbounded' })).flat();
    const enrichedRows = yield* enrichCollectorRowsWithRtkSavings(rows);
    return enrichedRows.map(stripCollectorMetadata);
  });
