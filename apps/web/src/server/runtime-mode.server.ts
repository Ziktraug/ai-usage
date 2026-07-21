import { parseRuntimeMode, type RuntimeMode, type RuntimeModeEnvironment } from '../runtime-mode';

export const getServerRuntimeMode = (
  environment: RuntimeModeEnvironment = {
    VITE_AI_USAGE_DEMO: process.env.VITE_AI_USAGE_DEMO,
    VITE_AI_USAGE_E2E: process.env.VITE_AI_USAGE_E2E,
  },
): RuntimeMode => parseRuntimeMode(environment);
