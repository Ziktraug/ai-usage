export type MemoryView = 'review' | 'knowledge';
export interface MemoryLocation {
  cursor: string | null;
  projectId: string | null;
  /** Pending proposal addressed by the review queue; validated with `isMemoryProposalId`. */
  proposalId: string | null;
  view: MemoryView;
}

const retiredMemoryParameters = ['analysis', 'analysisProject', 'element', 'episode'] as const;

/** Canonicalize Memory-owned state before rendering shell links; keep unrelated report filters. */
export const memoryCanonicalRedirect = (address: string): string | null => {
  const url = new URL(address, 'http://memory.invalid');
  const params = url.searchParams;
  const views = params.getAll('view');
  const view = params.get('view');
  let changed = false;
  if (views.length > 1 || (view !== null && view !== 'knowledge' && view !== 'review')) {
    params.set('view', view === 'review' ? 'review' : 'knowledge');
    changed = true;
  }
  const removed = view === 'review' ? retiredMemoryParameters : [...retiredMemoryParameters, 'cursor', 'proposal'];
  for (const key of removed) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed ? `${url.pathname}${url.search}${url.hash}` : null;
};

export const memoryLocation = (address: string): MemoryLocation => {
  const params = new URL(address, 'http://memory.invalid').searchParams;
  const view = params.get('view');
  return {
    view: view === 'review' ? 'review' : 'knowledge',
    projectId: params.get('project') || null,
    cursor: view === 'review' ? params.get('cursor') : null,
    proposalId: view === 'review' ? params.get('proposal') : null,
  };
};
export const memoryHref = (address: string, changes: Record<string, string | null>): string => {
  const location = memoryLocation(address);
  const params = new URLSearchParams();
  params.set('view', location.view);
  if (location.projectId) {
    params.set('project', location.projectId);
  }
  if (location.cursor) {
    params.set('cursor', location.cursor);
  }
  if (location.proposalId) {
    params.set('proposal', location.proposalId);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  return `/memory?${params}`;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** The web contract's proposal identity, checked before a malformed link reaches the service. */
export const isMemoryProposalId = (value: string): boolean => UUID.test(value);
export const memoryProjectError = (value: string | null): string | null =>
  value && !UUID.test(value) ? 'Enter a valid Project ID, or clear it to read all accessible Projects.' : null;
