import { createServerFn } from '@tanstack/solid-start';

export const getSyncState = createServerFn({ method: 'GET' }).handler(() =>
  import('./sync.server').then(({ readSyncStateForServer }) => readSyncStateForServer()),
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

export const removeSyncRemote = createServerFn({ method: 'POST' })
  .validator((input) => input)
  .handler(({ data }) =>
    import('./sync.server').then(({ removeSyncRemoteForServer, syncRemoteNameInputFrom }) =>
      removeSyncRemoteForServer(syncRemoteNameInputFrom(data)),
    ),
  );
