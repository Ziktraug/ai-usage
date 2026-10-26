import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { type WorkSessionReadScope, workSessionScopeSql } from './work-session-scope';

const matchingPaths = (scope: WorkSessionReadScope, candidates: readonly string[]): string[] => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE sessions (checkout TEXT)');
    const insert = db.query('INSERT INTO sessions VALUES (?)');
    for (const value of candidates) {
      insert.run(value);
    }
    const predicate = workSessionScopeSql(scope, { checkout: 'checkout', project: 'checkout' });
    return (
      db.query(`SELECT checkout FROM sessions WHERE ${predicate.sql} ORDER BY checkout`).all(...predicate.params) as {
        checkout: string;
      }[]
    ).map((row) => row.checkout);
  } finally {
    db.close();
  }
};

test('checkout scopes use literal boundaries and never match non-absolute paths, even under slash', () => {
  expect(
    matchingPaths({ kind: 'checkouts', checkoutPaths: ['/'] }, ['', 'relative', 'C:\\project', '/', '/project']),
  ).toEqual(['/', '/project']);
  expect(
    matchingPaths({ kind: 'checkouts', checkoutPaths: ['/work/a_%'] }, [
      '/work/a_%',
      '/work/a_%/child',
      '/work/a_%sibling',
      '/work/abc',
      'relative/work/a_%',
    ]),
  ).toEqual(['/work/a_%', '/work/a_%/child']);
});

test('project labels match only the complete directory name', () => {
  expect(
    matchingPaths({ kind: 'project-label', projectLabel: 'project' }, [
      '/a/project',
      '/b/project/',
      '/a/other-project',
      '/a/project/child',
      '/a/project-other',
    ]),
  ).toEqual(['/a/project', '/b/project/']);
});
