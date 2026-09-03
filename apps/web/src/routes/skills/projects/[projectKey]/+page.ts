import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * A project scope is a summary row in the worktable's Projects group, expandable in place. Routing
 * to one produced an empty page for every repository whose skill directories hold nothing.
 */
export const load: PageLoad = () => {
  redirect(307, '/skills');
};
