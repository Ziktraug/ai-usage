import { definePlugin } from 'nitro';
import { initializeWebReadObservabilityRuntime } from '../../src/server/web-read-observability.server';

export default definePlugin(async (nitroApp) => {
  await initializeWebReadObservabilityRuntime(nitroApp);
});
