import { Context, Layer } from 'effect';
import type { WideEventResource } from './model';
import { sanitizeWideEventResource } from './sanitize';

const AI_USAGE_SERVICE_VERSION = '0.1.0';

export interface WideEventResourceInput {
  readonly instanceId: string;
  readonly runtimeMode: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly surface: string;
}

export interface AiUsageWideEventResourceOptions {
  readonly instanceId: string;
  readonly nodeEnvironment: string | undefined;
  readonly surface: WideEventResource['surface'];
  readonly testRuntime?: boolean;
}

export class WideEventResourceService extends Context.Tag('@ai-usage/effect-runtime/WideEventResourceService')<
  WideEventResourceService,
  WideEventResource
>() {}

const resolveRuntimeMode = (
  nodeEnvironment: string | undefined,
  testRuntime: boolean,
): WideEventResource['runtimeMode'] => {
  if (nodeEnvironment === 'production') {
    return 'production';
  }
  return nodeEnvironment === 'test' || testRuntime ? 'test' : 'development';
};

export const makeAiUsageWideEventResource = ({
  instanceId,
  nodeEnvironment,
  surface,
  testRuntime = false,
}: AiUsageWideEventResourceOptions): WideEventResource => ({
  instanceId,
  runtimeMode: resolveRuntimeMode(nodeEnvironment, testRuntime),
  serviceName: 'ai-usage',
  serviceVersion: AI_USAGE_SERVICE_VERSION,
  surface,
});

export const makeWideEventResourceLayer = (input: WideEventResourceInput): Layer.Layer<WideEventResourceService> =>
  Layer.succeed(WideEventResourceService, sanitizeWideEventResource(input));

export const testWideEventResource: WideEventResource = {
  instanceId: 'test-instance',
  runtimeMode: 'test',
  serviceName: 'ai-usage',
  serviceVersion: '0.1.0-test',
  surface: 'web',
};

export const testWideEventResourceLayer = makeWideEventResourceLayer(testWideEventResource);
