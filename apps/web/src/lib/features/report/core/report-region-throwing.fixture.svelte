<script lang="ts">
  import ThrowingRegion from '../../shell/throwing-region.fixture.svelte';
  import ReportRegion from './report-region.svelte';
</script>
<ReportRegion kind="overview" onRetry={() => Promise.resolve()} pending={false}>
  <ThrowingRegion fail />
</ReportRegion>
