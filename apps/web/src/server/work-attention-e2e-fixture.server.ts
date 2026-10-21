import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectClaudeDesktopSessions } from '@ai-usage/local-collectors/claude-desktop-sessions';
import { createLocalHistoryStorage, LocalHistoryStorage } from '@ai-usage/local-machine/local-history';
import { seedHarnessHome } from '@ai-usage/local-machine/testing/harness-home';
import { importClaudeDesktopSessions, initializeUsageStore } from '@ai-usage/usage-store/writer';
import type { WorkAttentionInput } from '@ai-usage/web-contract/work';
import { Effect } from 'effect';
import { readWorkAttentionFromStore, type WorkAttentionServerResult } from './work-attention.server';

/**
 * The e2e composition of `work.attention`: one disposable store per process, built from the
 * representative seeded Desktop registry through the real collector and the real import, then
 * served by the real read model. The browser regression therefore crosses the same code as live
 * mode; only the store and the clock are synthetic. Writing the store here is the fixture's job
 * and happens only under `VITE_AI_USAGE_E2E=1`, never against the operator's store.
 */

/** The id the other e2e fixtures use for the current machine, so a machine filter matches. */
export const WORK_ATTENTION_E2E_MACHINE_ID = 'e2e-current-machine';
/** Fixed clock: the seeded ages (one hour to forty days) are relative to it. */
export const WORK_ATTENTION_E2E_NOW = new Date('2026-10-20T12:00:00.000Z');

let storePathPromise: Promise<string> | undefined;

const buildStore = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ai-usage-e2e-work-attention-'));
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  const dbPath = join(root, 'usage-store.sqlite');
  await Effect.runPromise(initializeUsageStore({ dbPath }));
  await seedHarnessHome(home, {
    claudeDesktopEpoch: WORK_ATTENTION_E2E_NOW,
    claudeDesktopSessions: 'representative',
    harnesses: ['claude'],
  });
  const collection = await Effect.runPromise(
    collectClaudeDesktopSessions({ machineId: WORK_ATTENTION_E2E_MACHINE_ID, now: () => WORK_ATTENTION_E2E_NOW }).pipe(
      Effect.provideService(LocalHistoryStorage, createLocalHistoryStorage(home)),
    ),
  );
  await Effect.runPromise(
    importClaudeDesktopSessions({
      collectedAt: WORK_ATTENTION_E2E_NOW,
      completeness: collection.completeness,
      dbPath,
      machineId: WORK_ATTENTION_E2E_MACHINE_ID,
      observations: collection.observations,
    }),
  );
  return dbPath;
};

/** Built once; a failed build is not cached so the next request retries rather than staying broken. */
export const getWorkAttentionE2EStorePath = (): Promise<string> => {
  if (storePathPromise === undefined) {
    storePathPromise = buildStore().catch((error: unknown) => {
      storePathPromise = undefined;
      throw error;
    });
  }
  return storePathPromise;
};

export const readE2EWorkAttention = async (
  request: WorkAttentionInput,
  signal?: AbortSignal,
): Promise<WorkAttentionServerResult> =>
  await readWorkAttentionFromStore({
    dbPath: await getWorkAttentionE2EStorePath(),
    now: () => WORK_ATTENTION_E2E_NOW,
    request,
    ...(signal === undefined ? {} : { signal }),
  });
