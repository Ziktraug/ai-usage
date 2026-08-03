import type { EventEmitter } from 'node:events';
import { defineHandler } from 'nitro';

const loopbackFixtureIsEnabled = (): boolean =>
  process.env.VITE_AI_USAGE_E2E === '1' && process.env.AI_USAGE_RPC_LOOPBACK_FIXTURE === '1';

const resolveRpcHandler = async (): Promise<(request: Request) => Promise<Response>> => {
  if (loopbackFixtureIsEnabled()) {
    const { handleNitroLoopbackFixtureRequest } = await import(
      '../../src/lib/server/rpc/nitro-loopback-fixture.server'
    );
    return handleNitroLoopbackFixtureRequest;
  }
  const { handleWebRpcRequest } = await import('../../src/lib/server/rpc/handler.server');
  return handleWebRpcRequest;
};

type ConnectionLifecycle = Pick<EventEmitter, 'off' | 'once'>;

export const requestWithConnectionSignal = (
  request: Request,
  socket: ConnectionLifecycle | undefined,
  response: ConnectionLifecycle | undefined,
): Request => {
  if (!socket) {
    return request;
  }
  const controller = new AbortController();
  const cleanup = (): void => {
    request.signal.removeEventListener('abort', forwardRequestAbort);
    socket.off('close', abortForConnectionClose);
    response?.off('finish', cleanup);
  };
  const forwardRequestAbort = (): void => {
    controller.abort(request.signal.reason);
    cleanup();
  };
  const abortForConnectionClose = (): void => {
    controller.abort(new Error('The RPC client connection closed before its response completed.'));
    cleanup();
  };
  request.signal.addEventListener('abort', forwardRequestAbort, { once: true });
  socket.once('close', abortForConnectionClose);
  response?.once('finish', cleanup);
  if (request.signal.aborted) {
    forwardRequestAbort();
  }
  return new Request(request, { method: request.method, signal: controller.signal });
};

export default defineHandler(
  async (event) =>
    await (await resolveRpcHandler())(
      requestWithConnectionSignal(event.req, event.runtime?.node?.req.socket, event.runtime?.node?.res),
    ),
);
