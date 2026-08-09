export interface RpcSubrequestNormalizationInput {
  readonly isSubRequest: boolean;
  readonly request: Request;
  readonly url: URL;
}

/**
 * SvelteKit strips Host from server-side `event.fetch` subrequests. Restore the
 * same-origin evidence only for framework-proven internal calls carrying the
 * request-owner metadata; ordinary HTTP requests must retain their trust
 * failures unchanged.
 */
export const normalizeOwnedRpcSubrequest = ({
  isSubRequest,
  request,
  url,
}: RpcSubrequestNormalizationInput): Request => {
  const isOwnedInternalRequest =
    isSubRequest && request.headers.get('host') === null && request.headers.has('x-ai-usage-request-owner');
  if (!isOwnedInternalRequest) {
    return request;
  }
  return new Request(request, {
    headers: {
      ...Object.fromEntries(request.headers),
      host: url.host,
      origin: url.origin,
      'sec-fetch-site': 'same-origin',
    },
  });
};
