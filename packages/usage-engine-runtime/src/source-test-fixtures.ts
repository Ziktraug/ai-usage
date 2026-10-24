import { Effect } from 'effect';
import type { SourceAdapterOptions } from './source-adapters';

/** Tests opt into simulated sources explicitly; a forgotten process fixture fails without a spawn. */
export const isolatedSourceOptions = {
  acliAvailable: () => false,
  claudeLiveAvailable: () => false,
  codexLiveAvailable: () => false,
  executorObservation: { which: () => null },
  ghAvailable: () => false,
  gitAvailable: () => false,
  workFactProcessRunner: (options) => Effect.die(new Error(`Missing process fixture for ${options.command}`)),
} satisfies SourceAdapterOptions;
