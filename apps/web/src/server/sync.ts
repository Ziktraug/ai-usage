import { createServerFn } from '@tanstack/solid-start';

export const getLanMergeState = createServerFn({ method: 'GET' }).handler(() =>
  import('./lan-merge.server').then(({ readLanMergeStateForServer }) => readLanMergeStateForServer()),
);

export const scanLanMergePeers = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./lan-merge.server').then(({ lanMergeScanInputFrom, scanLanMergePeersForServer }) =>
      scanLanMergePeersForServer(lanMergeScanInputFrom(data)),
    ),
  );

export const startLanMerge = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(() => import('./lan-merge.server').then(({ startLanMergeForServer }) => startLanMergeForServer()));

export const stopLanMerge = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(() => import('./lan-merge.server').then(({ stopLanMergeForServer }) => stopLanMergeForServer()));

export const mergeLanPeer = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./lan-merge.server').then(({ lanMergePeerInputFrom, mergeLanPeerForServer }) =>
      mergeLanPeerForServer(lanMergePeerInputFrom(data)),
    ),
  );

export const pairLanPeer = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./lan-merge.server').then(({ lanMergePairInputFrom, pairLanPeerForServer }) =>
      pairLanPeerForServer(lanMergePairInputFrom(data)),
    ),
  );
