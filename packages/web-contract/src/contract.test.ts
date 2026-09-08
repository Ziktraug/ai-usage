import { expect, test } from 'bun:test';
import { webContract } from './contract';
import { memoryContract } from './memory';
import { projectsContract } from './projects';
import { replicationContract } from './replication';
import { reportContract } from './report';
import { sessionContract } from './session';
import { skillsContract } from './skills';
import { syncContract } from './sync';

test('composes every RPC leaf under one root contract', () => {
  expect(webContract).toEqual({
    ...reportContract,
    memory: memoryContract,
    projects: projectsContract,
    replication: replicationContract,
    session: sessionContract,
    skills: skillsContract,
    sync: syncContract,
  });
});
