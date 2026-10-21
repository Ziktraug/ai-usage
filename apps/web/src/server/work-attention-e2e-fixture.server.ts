import {
  CLAUDE_DESKTOP_FIXTURE_PAIRS,
  claudeDesktopFixtureRegistry,
} from '@ai-usage/report-core/test-fixtures/claude-desktop-sessions';
import type {
  ClaudeDesktopCollectionCompleteness,
  ClaudeDesktopSessionObservation,
  WorkAttentionDataset,
} from '@ai-usage/report-core/work-attention';
import { parseClaudeDesktopSessionFile } from '@ai-usage/report-core/work-attention-native';
import { assembleWorkAttention, NO_SERVED_REVISION } from '@ai-usage/report-data/work-attention-read';
import type { WorkAttentionInput } from '@ai-usage/web-contract/work';
import type { WorkAttentionServerResult } from './work-attention.server';

/**
 * The e2e composition of `work.attention`: the representative seeded registry, normalized by the
 * same parser the collector runs and assembled by the same read model live mode runs, held in
 * memory for the process. The web app may not import the collector or the store writer (package
 * boundaries), so the only link live mode has and this one lacks is the SQLite round trip; every
 * clamp, fold, interpretation and ranking is the production code.
 */

/** The id the other e2e fixtures use for the current machine, so a machine filter matches. */
export const WORK_ATTENTION_E2E_MACHINE_ID = 'e2e-current-machine';
/** Fixed clock: the seeded ages (one hour to forty days) are relative to it. */
export const WORK_ATTENTION_E2E_NOW = new Date('2026-10-20T12:00:00.000Z');
const E2E_HOME = '/e2e/home';
const E2E_REPOSITORY = `${E2E_HOME}/work/fixture`;
const E2E_TRANSCRIPT_ID = 'claude-fixture-025';

interface E2EWorkAttentionSource {
  readonly completeness: ClaudeDesktopCollectionCompleteness;
  readonly observations: readonly ClaudeDesktopSessionObservation[];
}

let source: E2EWorkAttentionSource | undefined;

const buildSource = (): E2EWorkAttentionSource => {
  const registry = claudeDesktopFixtureRegistry({
    cliSessionIdWithTranscript: E2E_TRANSCRIPT_ID,
    epoch: WORK_ATTENTION_E2E_NOW,
    repository: E2E_REPOSITORY,
    variant: 'representative',
  });
  const observedAt = WORK_ATTENTION_E2E_NOW.toISOString();
  const observations: ClaudeDesktopSessionObservation[] = [];
  const completeness = { filesParsed: 0, filesSeen: 0, rejected: 0, truncated: false, unsupported: 0 };
  for (const entry of registry.documents) {
    completeness.filesSeen += 1;
    const pairIndex = CLAUDE_DESKTOP_FIXTURE_PAIRS.findIndex((pair) => pair.account === entry.account);
    const result = parseClaudeDesktopSessionFile(entry.document, {
      accountDirectory: entry.account,
      fileModifiedAt: entry.modifiedAt.toISOString(),
      machineId: WORK_ATTENTION_E2E_MACHINE_ID,
      observedAt,
      organizationDirectory: entry.organization,
      relativeFilePath: `.config/Claude/claude-code-sessions/${entry.account}/${entry.organization}/${entry.fileName}`,
    });
    if (result.kind === 'observation') {
      completeness.filesParsed += 1;
      observations.push(result.observation);
    } else if (result.kind === 'unsupported') {
      completeness.unsupported += 1;
      if (result.observation !== null) {
        observations.push(result.observation);
      }
    } else {
      completeness.rejected += 1;
    }
    if (pairIndex < 0) {
      throw new Error('The e2e Desktop registry names an account outside its pairs.');
    }
  }
  return { completeness, observations };
};

const getSource = (): E2EWorkAttentionSource => {
  source ??= buildSource();
  return source;
};

export const readE2EWorkAttention = (request: WorkAttentionInput): Promise<WorkAttentionServerResult> => {
  const { completeness, observations } = getSource();
  const data: WorkAttentionDataset = assembleWorkAttention({
    collectionStates: [
      { collectedAt: WORK_ATTENTION_E2E_NOW.toISOString(), completeness, machineId: WORK_ATTENTION_E2E_MACHINE_ID },
    ],
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.machineId === undefined || request.machineId === null ? {} : { machineId: request.machineId }),
    now: WORK_ATTENTION_E2E_NOW,
    observations,
    sessions: NO_SERVED_REVISION,
  });
  return Promise.resolve({ data, ok: true });
};
