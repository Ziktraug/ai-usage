import type { SyncFleet } from '@ai-usage/web-contract/sync';
import type { ManualOperationResult } from '../../manual-transfer-contract';
import { resolveSolidWebRpcClient } from './solid-client';
import { createSyncBrowserAdapter } from './sync-client';

interface ManualMergeExport {
  readonly bytes: number;
  readonly filename: string;
  readonly rows: number;
  readonly text: string;
}

const unavailable = <Data>(): ManualOperationResult<Data> => ({
  error: { message: 'Manual synchronization is unavailable.', tag: 'Unavailable' },
  ok: false,
});

export const getSyncFleet = async (): Promise<ManualOperationResult<SyncFleet>> => {
  try {
    const rpc = await resolveSolidWebRpcClient();
    return { data: await createSyncBrowserAdapter(rpc.sync).fleet(), ok: true };
  } catch {
    return unavailable();
  }
};

export const exportManualMergeBundle = async (
  signal?: AbortSignal,
): Promise<ManualOperationResult<ManualMergeExport>> => {
  try {
    signal?.throwIfAborted();
    const rpc = await resolveSolidWebRpcClient();
    signal?.throwIfAborted();
    const { filename, response } = await createSyncBrowserAdapter(rpc.sync).downloadManualMerge(signal);
    signal?.throwIfAborted();
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    signal?.throwIfAborted();
    if (!(typeof parsed === 'object' && parsed !== null && 'rows' in parsed && Array.isArray(parsed.rows))) {
      return unavailable();
    }
    return {
      data: {
        bytes: new TextEncoder().encode(text).byteLength,
        filename,
        rows: parsed.rows.length,
        text,
      },
      ok: true,
    };
  } catch {
    signal?.throwIfAborted();
    return unavailable();
  }
};
