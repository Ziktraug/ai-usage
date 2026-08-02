const encoder = new TextEncoder();
const holdMilliseconds = 31_100;

/** @type {import('./$types').RequestHandler} */
export const GET = ({ request }) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let holdTimer;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: ready\ndata: 0\n\n'));
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(holdTimer);
        controller.close();
      };
      holdTimer = setTimeout(() => {
        controller.enqueue(encoder.encode(`event: held\ndata: ${holdMilliseconds}\n\n`));
      }, holdMilliseconds);
      request.signal.addEventListener('abort', close, { once: true });
    },
    cancel() {
      clearTimeout(holdTimer);
      closed = true;
    },
  });
  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
    },
  });
};
