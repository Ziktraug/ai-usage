import { describe, expect, test } from 'bun:test';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';
import { load } from './+page.server';

type LoadEvent = Parameters<typeof load>[0];
type RouteFetch = (...args: Parameters<LoadEvent['fetch']>) => ReturnType<LoadEvent['fetch']>;
const eventFor = (address: string, isDataRequest: boolean, fetch: RouteFetch): LoadEvent =>
  // The actual route load consumes only these three RequestEvent fields.
  ({ url: new URL(address, 'http://memory.invalid'), isDataRequest, fetch }) as LoadEvent;
const retiredAddress = '/memory?view=analyses&analysis=historical-account&cursor=retired-cursor';

describe('Memory canonical route boundary', () => {
  test.each([false, true])('redirects retired addresses before acquisition, data request=%s', async (isDataRequest) => {
    let reads = 0;
    const event = eventFor(retiredAddress, isDataRequest, () => {
      reads++;
      return Promise.reject(new Error('Retired addresses must redirect before Memory acquisition'));
    });
    await expect(Promise.resolve(load(event))).rejects.toMatchObject({
      status: 307,
      location: '/memory?view=knowledge',
    });
    expect(reads).toBe(0);
  });

  test('serves canonical client/history requests as a deferred Query delta without another redirect', async () => {
    const result = await load(
      eventFor('/memory?view=review&proposal=invalid-but-visible&cursor=current', true, () =>
        Promise.reject(new Error('Client/history navigation does not reacquire Memory')),
      ),
    );
    expect(result).toEqual({ queryState: { dehydratedState: { mutations: [], queries: [] } } });
  });

  test('serves canonical document requests through the existing bounded SSR Query load', async () => {
    const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
    const requests: string[] = [];
    const result = await load(
      eventFor('/memory?view=knowledge', false, (request) => {
        requests.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
        return Promise.resolve(
          Response.json(
            serializer.serialize({
              nextCursor: null,
              proposals: [],
              spaceId: '0198f179-4837-7000-8000-000000000001',
            }),
          ),
        );
      }),
    );
    expect(requests).toEqual(['/rpc/memory/proposalReviews']);
    expect(result).toHaveProperty('queryState.dehydratedState.queries.length', 1);
  });
});
