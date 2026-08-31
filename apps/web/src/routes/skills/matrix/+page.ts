import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/**
 * The exposure matrix was folded into the worktable (plan 113): placement marks now sit beside the
 * invocation counts they should always have been read against. The URL keeps working.
 */
export const load: PageLoad = () => {
  redirect(307, '/skills');
};
