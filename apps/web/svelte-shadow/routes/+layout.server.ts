import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
  runtimeMode: locals.runtimeMode ?? 'live',
});
