const host = process.env.HOST;
const port = Number(process.env.PORT);
const holdMs = Number(process.argv[2] ?? '31100');
if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port <= 0) {
  throw new Error('Fixture requires numeric loopback HOST and PORT.');
}

const encoder = new TextEncoder();
const server = Bun.serve({
  hostname: host,
  idleTimeout: 45,
  port,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/') {
      return new Response('<main data-runtime-fixture="sveltekit-bun">Meaningful server-rendered content</main>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (pathname === '/runtime-asset.txt') {
      return new Response('sveltekit-runtime-asset-ok\n');
    }
    if (pathname === '/api/events') {
      let timer;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: ready\ndata: 0\n\n'));
          timer = setTimeout(() => {
            controller.enqueue(encoder.encode(`event: held\ndata: ${holdMs}\n\n`));
          }, holdMs);
        },
        cancel() {
          clearTimeout(timer);
        },
      });
      return new Response(stream, {
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        },
      });
    }
    return new Response('Not found', { status: 404 });
  },
});

const shutdown = async () => {
  await server.stop(true);
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
