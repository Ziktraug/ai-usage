import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLocalDefaultBranch, readSshHostAliases } from './local-git';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const temporary = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-git-'));
  roots.push(root);
  return root;
};

describe('local git facts for branch evidence', () => {
  test('reads the default branch origin names, from any folder of the clone', () => {
    const clone = temporary();
    mkdirSync(path.join(clone, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    mkdirSync(path.join(clone, 'packages', 'app'), { recursive: true });
    writeFileSync(path.join(clone, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/trunk\n');
    expect(readLocalDefaultBranch(path.join(clone, 'packages', 'app'))).toBe('trunk');
    expect(readLocalDefaultBranch(temporary())).toBeNull();
  });

  test('maps exact SSH host aliases to their host name and skips patterns', () => {
    const home = temporary();
    mkdirSync(path.join(home, '.ssh'));
    writeFileSync(
      path.join(home, '.ssh', 'config'),
      [
        '# Host commented.example',
        '#   HostName github.com',
        'Host github-perso.com work-gh',
        '  HostName github.com',
        'Host *.internal',
        '  HostName bastion.example',
        'Host github.com',
        '  HostName github.com',
        'Match host other',
        '  HostName ignored.example',
      ].join('\n'),
    );
    expect(readSshHostAliases(home)).toEqual({ 'github-perso.com': 'github.com', 'work-gh': 'github.com' });
    expect(readSshHostAliases(temporary())).toEqual({});
  });
});
