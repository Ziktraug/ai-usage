export const svelteKitPhases = ['build', 'check', 'dev'] as const;

export type SvelteKitPhase = (typeof svelteKitPhases)[number];

export interface SvelteKitOutputPaths {
  adapterDirectory: string;
  intermediateDirectory: string;
  phase: SvelteKitPhase;
  viteCacheDirectory: string;
}

const isSvelteKitPhase = (value: string): value is SvelteKitPhase =>
  svelteKitPhases.some((candidate) => candidate === value);

export const resolveSvelteKitOutputPaths = (
  requestedPhase: string | undefined = process.env.AI_USAGE_SVELTEKIT_PHASE,
): SvelteKitOutputPaths => {
  const phase = requestedPhase ?? 'check';
  if (!isSvelteKitPhase(phase)) {
    throw new Error(`Invalid SvelteKit phase: ${phase}`);
  }

  const intermediateDirectory = `.svelte-kit/${phase}`;
  return {
    adapterDirectory: phase === 'build' ? '.output-build/sveltekit' : `${intermediateDirectory}/adapter-bun`,
    intermediateDirectory,
    phase,
    viteCacheDirectory: `${intermediateDirectory}/vite`,
  };
};
