import { createServer as createHttpServer } from 'node:http';
import { createServer as createViteServer, type InlineConfig } from 'vite';

const LOOPBACK_HOST = '127.0.0.1';

export interface BrowserFixtureServer {
  close(): Promise<void>;
  readonly port: number;
}

const listenOnEphemeralPort = (server: ReturnType<typeof createHttpServer>): Promise<number> =>
  new Promise((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error);
    server.once('error', rejectListen);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Browser fixture HTTP server did not expose its loopback port.'));
        return;
      }
      resolve(address.port);
    });
  });

const closeHttpServer = (server: ReturnType<typeof createHttpServer>): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });

export const startBrowserFixtureServer = async (config: InlineConfig): Promise<BrowserFixtureServer> => {
  const viteServer = await createViteServer({
    ...config,
    server: { ...config.server, hmr: false, middlewareMode: true },
  });
  const httpServer = createHttpServer(viteServer.middlewares);
  try {
    const port = await listenOnEphemeralPort(httpServer);
    return {
      close: async () => {
        const results = await Promise.allSettled([closeHttpServer(httpServer), viteServer.close()]);
        const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Browser fixture server cleanup failed');
        }
      },
      port,
    };
  } catch (error) {
    await viteServer.close();
    throw error;
  }
};
