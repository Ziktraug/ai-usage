import { authorizationScopeSql } from './internal/authorization-query';

export const projectAuthorizationScopeSqlForBenchmark = (): string => {
  const query = authorizationScopeSql('view_project', 'project');
  if (query === null) {
    throw new Error('The Project authorization query is unavailable.');
  }
  return query;
};
