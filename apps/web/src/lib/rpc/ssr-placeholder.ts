const NON_CALLABLE_PROPERTIES = new Set(['then', 'catch', 'finally']);

/**
 * Stand-in for a browser RPC adapter while rendering on the server.
 *
 * Report owners take a client at construction but only ever call it from effects, event handlers or
 * `onMount` — none of which run during SSR. Handing them this placeholder lets the report render
 * server-side without a network client, and turns any future call from the render pass into a named
 * rejection instead of a silent request. `then`/`catch`/`finally` stay undefined so the placeholder
 * is never mistaken for a thenable by an `await`.
 */
export const ssrUnavailableClient = <Client extends object>(label: string): Client =>
  new Proxy({} as Client, {
    get: (_target, property) => {
      if (typeof property === 'symbol' || NON_CALLABLE_PROPERTIES.has(property)) {
        return;
      }
      return () =>
        Promise.reject(new Error(`The ${label} RPC client is unavailable during SSR (called ${String(property)}).`));
    },
  });
