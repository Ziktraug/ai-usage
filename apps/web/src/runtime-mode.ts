export type RuntimeMode = 'demo' | 'e2e' | 'live';

export interface RuntimeModeEnvironment {
  readonly VITE_AI_USAGE_DEMO: string | undefined;
  readonly VITE_AI_USAGE_E2E: string | undefined;
}

const enabled = (value: string | undefined): boolean => value === '1';

export const parseRuntimeMode = (environment: RuntimeModeEnvironment): RuntimeMode => {
  const demo = enabled(environment.VITE_AI_USAGE_DEMO);
  const e2e = enabled(environment.VITE_AI_USAGE_E2E);
  if (demo && e2e) {
    throw new Error('VITE_AI_USAGE_DEMO and VITE_AI_USAGE_E2E cannot both be enabled.');
  }
  if (demo) {
    return 'demo';
  }
  return e2e ? 'e2e' : 'live';
};
