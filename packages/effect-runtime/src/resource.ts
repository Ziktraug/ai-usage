import { Context, Layer } from 'effect';
import type { WideEventResource } from './model';
import { sanitizeWideEventResource } from './sanitize';

export interface WideEventResourceInput {
  readonly instanceId: string;
  readonly runtimeMode: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly surface: string;
}

export class WideEventResourceService extends Context.Tag('@ai-usage/effect-runtime/WideEventResourceService')<
  WideEventResourceService,
  WideEventResource
>() {}

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
