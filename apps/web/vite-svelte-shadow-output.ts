export const svelteShadowPhases = ['build', 'check', 'dev'] as const;

export type SvelteShadowPhase = (typeof svelteShadowPhases)[number];

export interface SvelteShadowOutputPaths {
  adapterDirectory: string;
  intermediateDirectory: string;
  phase: SvelteShadowPhase;
  viteCacheDirectory: string;
}

const isSvelteShadowPhase = (value: string): value is SvelteShadowPhase =>
  svelteShadowPhases.some((candidate) => candidate === value);

export const resolveSvelteShadowOutputPaths = (
  requestedPhase: string | undefined = process.env.AI_USAGE_SVELTEKIT_SHADOW_MODE,
): SvelteShadowOutputPaths => {
  const phase = requestedPhase ?? 'check';
  if (!isSvelteShadowPhase(phase)) {
    throw new Error(`Invalid SvelteKit shadow phase: ${phase}`);
  }

  const intermediateDirectory = `.svelte-kit-shadow/${phase}`;
  return {
    adapterDirectory: `.output-svelte-shadow/${phase}`,
    intermediateDirectory,
    phase,
    viteCacheDirectory: `${intermediateDirectory}/vite`,
  };
};
