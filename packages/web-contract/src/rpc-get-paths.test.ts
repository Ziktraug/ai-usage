import { expect, test } from 'bun:test';
import { renderRpcGetPathsModule } from '../scripts/generate-rpc-get-paths';
import { webContract } from './contract';
import { rpcGetPaths } from './rpc-get-paths.generated';
import { rpcGetPathsFor } from './rpc-procedure-table';

test('the generated browser GET table is exactly what the contract declares (run `bun run generate` if not)', async () => {
  const expected = rpcGetPathsFor(webContract);
  const source = await Bun.file(new URL('./rpc-get-paths.generated.ts', import.meta.url)).text();

  expect(rpcGetPaths).toEqual(expected);
  expect(source).toBe(renderRpcGetPathsModule(expected));
});
