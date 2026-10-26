import type { DelegationSaveSettingsInput as DelegationSaveSettingsWireInput } from '@ai-usage/web-contract/delegation';
import type { DelegationClient } from '../../rpc/delegation-client';
import type {
  DelegationPageClient,
  DelegationSaveOutcome,
  DelegationSaveSettingsInput,
  DelegationSimulateInput,
  DelegationSimulateOutcome,
} from './delegation-contract';

export type DelegationPageTransport = Pick<DelegationClient, 'saveSettings' | 'simulate'>;

type JsonRecord = NonNullable<DelegationSaveSettingsWireInput['delegation']>;

/** The typed sections as the raw JSON records the wire schema takes; absent optionals disappear. */
const asJsonRecord = (value: object): JsonRecord => JSON.parse(JSON.stringify(value)) as JsonRecord;

export const toWireSaveInput = (input: DelegationSaveSettingsInput): DelegationSaveSettingsWireInput => ({
  expectedRevision: input.expectedRevision,
  ...(input.delegation === undefined ? {} : { delegation: asJsonRecord(input.delegation) }),
  ...(input.executors === undefined ? {} : { executors: input.executors.map(asJsonRecord) }),
  ...(input.reviewTargets === undefined ? {} : { reviewTargets: input.reviewTargets.map(asJsonRecord) }),
});

/**
 * The page's mutations as outcomes it renders: a revision conflict keeps the draft and names the
 * revision now on disk, an invalid write lists its issues by config path, anything else keeps its
 * public tag. The settings are re-read by the form that saved, never here.
 */
export const createDelegationPageClient = (transport: DelegationPageTransport): DelegationPageClient => ({
  saveSettings: async (input: DelegationSaveSettingsInput): Promise<DelegationSaveOutcome> => {
    const result = await transport.saveSettings(toWireSaveInput(input));
    if (result.ok) {
      return { kind: 'written', revision: result.data.revision };
    }
    const { error } = result;
    if (error.tag === 'Conflict') {
      return { kind: 'conflict', message: error.message, revision: error.revision ?? null };
    }
    if (error.tag === 'InvalidInput') {
      return { issues: error.issues ?? [], kind: 'invalid', message: error.message };
    }
    return { kind: 'unavailable', message: error.message, tag: error.tag };
  },
  simulate: async (input: DelegationSimulateInput): Promise<DelegationSimulateOutcome> => {
    const result = await transport.simulate(input);
    return result.ok
      ? { kind: 'qualified', qualification: result.data }
      : { kind: 'unavailable', message: result.error.message, tag: result.error.tag };
  },
});
