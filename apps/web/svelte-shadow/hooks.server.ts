import type { Handle } from '@sveltejs/kit';

process.once('sveltekit:shutdown', () => {
  setTimeout(() => process.exit(0), 0);
});

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('x-ai-usage-shadow', 'sveltekit');
  return response;
};
