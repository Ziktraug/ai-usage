import { Effect } from 'effect';
import type { LocalHistoryError } from '../errors';
import { HARNESS_METADATA, type HarnessKey, type HarnessMetadata, harnessKeys } from '../harness-metadata';
import type { LocalHistoryStorage as LocalHistoryStorageService } from '../local-history';
import type { Row } from '../types';
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
    return (yield* Effect.all(effects, { concurrency: 'unbounded' })).flat();
  });
