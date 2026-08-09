import { expect, test } from 'bun:test';
import { webContract } from './contract';
import { reportContract } from './report';
import { sessionContract } from './session';
import { skillsContract } from './skills';
import { syncContract } from './sync';

test('composes every V1-V4 RPC leaf under one root contract', () => {
  expect(webContract).toEqual({
    ...reportContract,
    session: sessionContract,
    skills: skillsContract,
    sync: syncContract,
  });
});
