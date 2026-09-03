import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** The global scope is a group of the worktable, not a page of its own (plan 113). */
export const load: PageLoad = () => {
  redirect(307, '/skills');
};
