import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends, locals }) => {
  depends('ai-usage:report-root');
  if (locals.shellE2eError) {
    error(503, 'Synthetic shell route failure');
  }
};
