import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

export const RPC_PATH_PREFIX = '/rpc/';
export const RPC_ROUTE_GLOB = '**/rpc/**';
export const MANUAL_MERGE_DOWNLOAD_PATH = '/api/manual-merge/download';
export const MANUAL_MERGE_UPLOAD_PATH = '/api/manual-merge/upload';

const DEFINED_INTERCEPTION_ERROR_STATUS = 503;
const rpcSerializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isRpcPathname = (pathname: string): boolean =>
  pathname === RPC_PATH_PREFIX.slice(0, -1) || pathname.startsWith(RPC_PATH_PREFIX);

export const encodeRpcResponseBody = (value: unknown): string => JSON.stringify(rpcSerializer.serialize(value));

export const decodeRpcResponseBody = (body: string): unknown => rpcSerializer.deserialize(JSON.parse(body));

export const rpcStringFieldValues = (body: string, fieldName: string): string[] => {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, fieldValue] of Object.entries(value)) {
      if (key === fieldName && typeof fieldValue === 'string') {
        values.push(fieldValue);
      }
      visit(fieldValue);
    }
  };
  visit(decodeRpcResponseBody(body));
  return values;
};

export interface RpcRouteFulfillment {
  readonly body: string;
  readonly status: number;
}

export const rpcRouteFulfillmentForClientResult = (result: unknown): RpcRouteFulfillment => {
  if (!(isRecord(result) && typeof result.ok === 'boolean')) {
    throw new Error('An intercepted RPC client result must expose its legacy ok discriminator.');
  }
  if (result.ok) {
    if (!Object.hasOwn(result, 'data')) {
      throw new Error('An intercepted successful RPC client result must expose data.');
    }
    return { body: encodeRpcResponseBody(result.data), status: 200 };
  }

  const error = result.error;
  if (!(isRecord(error) && typeof error.message === 'string' && typeof error.tag === 'string')) {
    throw new Error('An intercepted failed RPC client result must expose a public tag and message.');
  }
  return {
    body: encodeRpcResponseBody({
      code: error.tag,
      data: undefined,
      defined: true,
      message: error.message,
      status: DEFINED_INTERCEPTION_ERROR_STATUS,
    }),
    status: DEFINED_INTERCEPTION_ERROR_STATUS,
  };
};
