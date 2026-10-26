/** Explicit read scope; paths identify checkouts, never session lineage or a business subject. */
export type WorkSessionReadScope =
  | { readonly kind: 'checkouts'; readonly checkoutPaths: readonly string[] }
  | { readonly kind: 'project-label'; readonly projectLabel: string };

export const MAX_WORK_SCOPE_CHECKOUTS = 10;
const MAX_PATH = 4096;
const INVALID_LABEL = /[\0/]/u;
const TRAILING_SLASHES = /\/+$/u;

export const validWorkSessionReadScope = (scope: WorkSessionReadScope): boolean => {
  if (scope.kind === 'project-label') {
    return (
      scope.projectLabel.trim().length > 0 &&
      scope.projectLabel.length <= 256 &&
      !INVALID_LABEL.test(scope.projectLabel)
    );
  }
  return (
    scope.checkoutPaths.length > 0 &&
    scope.checkoutPaths.length <= MAX_WORK_SCOPE_CHECKOUTS &&
    scope.checkoutPaths.every((value) => value.startsWith('/') && value.length <= MAX_PATH && !value.includes('\0'))
  );
};

/** Literal path comparisons, with a separator boundary and bound parameters (no LIKE wildcards). */
export const workSessionScopeSql = (
  scope: WorkSessionReadScope,
  paths: { readonly checkout: string; readonly project: string; readonly fallbackLabel?: string },
): { readonly params: readonly string[]; readonly sql: string } => {
  if (scope.kind === 'project-label') {
    const project = `rtrim(${paths.project}, '/')`;
    const suffix = `/${scope.projectLabel}`;
    const match = `(${project} = ? OR substr(${project}, -length(?)) = ?)`;
    return {
      params: [scope.projectLabel, suffix, suffix, ...(paths.fallbackLabel === undefined ? [] : [scope.projectLabel])],
      sql:
        paths.fallbackLabel === undefined
          ? match
          : `(${match} OR (${paths.project} IS NULL AND ${paths.fallbackLabel} = ?))`,
    };
  }
  const checkout = `rtrim(${paths.checkout}, '/')`;
  return {
    params: scope.checkoutPaths.flatMap((value) => {
      const target = value === '/' ? '' : value.replace(TRAILING_SLASHES, '');
      return [target, `${target}/`, `${target}/`];
    }),
    sql: `(substr(${paths.checkout}, 1, 1) = '/' AND (${scope.checkoutPaths.map(() => `(${checkout} = ? OR substr(${checkout}, 1, length(?)) = ?)`).join(' OR ')}))`,
  };
};
