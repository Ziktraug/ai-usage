import { describe, expect, test } from 'bun:test';
import { clientErrorMessage, routeErrorMessage } from './report-render-error';

describe('error route message', () => {
  test('shows the route’s own error message', () => {
    expect(routeErrorMessage(503, { message: 'The campaigns store is missing.' })).toBe(
      'The campaigns store is missing.',
    );
  });

  test('points to the server output when SvelteKit kept the cause back', () => {
    for (const error of [null, { message: '' }, { message: 'Internal Error' }]) {
      expect(routeErrorMessage(500, error)).toBe(
        'The server failed to build this page (HTTP 500); its output names the cause.',
      );
    }
  });

  test('names an unexpected browser exception, bounded', () => {
    expect(clientErrorMessage(new Error('Keyed each block has duplicate key'))).toBe(
      'This page failed in the browser: Keyed each block has duplicate key',
    );
    expect(clientErrorMessage(new Error('x'.repeat(1000))).length).toBeLessThan(400);
    expect(clientErrorMessage('  ')).toBe('This page failed in the browser: no message');
    expect(clientErrorMessage('thrown string')).toBe('This page failed in the browser: thrown string');
  });
});
