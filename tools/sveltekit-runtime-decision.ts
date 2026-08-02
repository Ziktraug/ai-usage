export const svelteKitRuntimeDecision = {
  adapter: {
    package: 'svelte-adapter-bun',
    version: '1.0.1',
  },
  configuration: {
    host: '127.0.0.1',
    idleTimeoutSeconds: 45,
    launchFlags: ['--no-env-file', '--no-install'],
    shutdownEvent: 'sveltekit:shutdown',
  },
  pins: {
    '@ark-ui/svelte': '5.22.1',
    '@orpc/client': '1.14.13',
    '@orpc/contract': '1.14.13',
    '@orpc/server': '1.14.13',
    '@orpc/svelte-query': '1.14.13',
    '@pandacss/dev': '1.12.0',
    '@sveltejs/kit': '2.70.2',
    '@sveltejs/vite-plugin-svelte': '7.2.0',
    '@tanstack/svelte-query': '6.1.38',
    svelte: '5.56.8',
    typescript: '5.9.3',
    valibot: '1.4.2',
    vite: '8.2.0',
  },
  rejectedAdapter: {
    package: '@sveltejs/adapter-node',
    version: '5.5.7',
    reasons: [
      'Bun did not propagate response-side disconnect through node:http to Request.signal.',
      'The generated signal handler did not terminate the Bun process after closeAllConnections.',
    ],
  },
} as const;

export type SvelteKitRuntimeDecision = typeof svelteKitRuntimeDecision;
