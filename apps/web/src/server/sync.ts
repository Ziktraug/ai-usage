import { createServerFn } from '@tanstack/solid-start';

export const getSyncState = createServerFn({ method: 'GET' }).handler(() =>
  import('./sync.server').then(({ readSyncStateForServer }) => readSyncStateForServer()),
);

export const getSyncServeState = createServerFn({ method: 'GET' }).handler(() =>
  import('./sync-serve.server').then(({ getSyncServeStateForServer }) => getSyncServeStateForServer()),
);

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

export const startSyncServe = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync-serve.server').then(({ startSyncServeForServer, syncServeStartInputFrom }) =>
      startSyncServeForServer(syncServeStartInputFrom(data)),
    ),
  );

export const startSyncServeShare = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync-serve.server').then(({ startSyncServeShareForServer, syncServeShareInputFrom }) =>
      startSyncServeShareForServer(syncServeShareInputFrom(data)),
    ),
  );

export const stopSyncServe = createServerFn({ method: 'POST' }).handler(() =>
  import('./sync-serve.server').then(({ stopSyncServeForServer }) => stopSyncServeForServer()),
);

export const discoverSyncPeers = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ discoverSyncPeersForServer, syncDiscoverInputFrom }) =>
      discoverSyncPeersForServer(syncDiscoverInputFrom(data)),
    ),
  );

export const validateSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ syncValidateRemoteInputFrom, validateSyncRemoteForServer }) =>
      validateSyncRemoteForServer(syncValidateRemoteInputFrom(data)),
    ),
  );

export const upsertSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ syncRemoteInputFrom, upsertSyncRemoteForServer }) =>
      upsertSyncRemoteForServer(syncRemoteInputFrom(data)),
    ),
  );

export const setSyncRemoteEnabled = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ setSyncRemoteEnabledForServer, syncRemoteEnabledInputFrom }) =>
      setSyncRemoteEnabledForServer(syncRemoteEnabledInputFrom(data)),
    ),
  );

export const pullSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ pullSyncRemoteForServer, syncRemoteNameInputFrom }) =>
      pullSyncRemoteForServer(syncRemoteNameInputFrom(data)),
    ),
  );

export const pullOneShotSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ pullOneShotSyncRemoteForServer, syncRemoteInputFrom }) =>
      pullOneShotSyncRemoteForServer(syncRemoteInputFrom(data)),
    ),
  );

export const importSyncInvite = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ importSyncInviteForServer, syncInviteInputFrom }) =>
      importSyncInviteForServer(syncInviteInputFrom(data)),
    ),
  );

export const removeSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ removeSyncRemoteForServer, syncRemoteNameInputFrom }) =>
      removeSyncRemoteForServer(syncRemoteNameInputFrom(data)),
    ),
  );
