import { parseRuntimeMode, type RuntimeMode } from './runtime-mode';

export const getBrowserRuntimeMode = (): RuntimeMode =>
  parseRuntimeMode({
    VITE_AI_USAGE_DEMO: import.meta.env?.VITE_AI_USAGE_DEMO,
    VITE_AI_USAGE_E2E: import.meta.env?.VITE_AI_USAGE_E2E,
  });
