<script lang="ts">
  import { createWebRpcClient, createWebRpcQueryUtils } from '../rpc/client';
  import { installWebQueryRpcContext } from './rpc-context.svelte';
  import RpcContextReader from './rpc-context-reader.fixture.svelte';

  const rpc = createWebRpcClient({ url: 'http://rpc-context.invalid/rpc' });
  installWebQueryRpcContext({ orpc: createWebRpcQueryUtils(rpc), rpc });
</script>

<RpcContextReader />
