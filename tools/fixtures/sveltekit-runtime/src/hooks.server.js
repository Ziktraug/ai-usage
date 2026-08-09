process.once('sveltekit:shutdown', () => {
  setTimeout(() => process.exit(0), 0);
});

/** @type {import('@sveltejs/kit').Handle} */
export const handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set('x-runtime-fixture', 'svelte-adapter-bun');
  return response;
};
