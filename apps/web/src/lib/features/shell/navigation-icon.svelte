<script lang="ts">
  import type { ShellIconName } from './navigation';

  let { name, size = 18 }: { name: ShellIconName; size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  fill="none"
  height={size}
  stroke="currentColor"
  stroke-linecap="round"
  stroke-linejoin="round"
  stroke-width="2"
  style="flex-shrink: 0"
  viewBox="0 0 24 24"
  width={size}
  xmlns="http://www.w3.org/2000/svg"
>
  {#if name === 'overview'}
    <rect height="9" rx="1" width="7" x="3" y="3"></rect>
    <rect height="5" rx="1" width="7" x="14" y="3"></rect>
    <rect height="9" rx="1" width="7" x="14" y="12"></rect>
    <rect height="5" rx="1" width="7" x="3" y="16"></rect>
  {:else if name === 'sessions'}
    <path d="M8 6h13M8 12h13M8 18h13"></path>
    <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"></path>
  {:else if name === 'breakdown'}
    <path d="M21.2 15.9A10 10 0 1 1 8 2.8"></path>
    <path d="M22 12A10 10 0 0 0 12 2v10z"></path>
  {:else if name === 'skills'}
    <path d="m11.3 3.2-1.6 4.6-4.6 1.6 4.6 1.6 1.6 4.6 1.6-4.6 4.6-1.6-4.6-1.6z"></path>
    <path d="M18 14.5V19M20.2 16.8h-4.4"></path>
    <path d="M5.5 15.5V19M7.2 17.2H3.8"></path>
  {:else if name === 'projects'}
    <path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
    <path d="M3 7.5V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2.5"></path>
  {:else if name === 'memory'}
    <path d="M12 4.5a3.5 3.5 0 0 0-6.7 1.4A3.5 3.5 0 0 0 3 12a3.5 3.5 0 0 0 2.3 6.1A3.5 3.5 0 0 0 12 19.5"></path>
    <path d="M12 4.5a3.5 3.5 0 0 1 6.7 1.4A3.5 3.5 0 0 1 21 12a3.5 3.5 0 0 1-2.3 6.1A3.5 3.5 0 0 1 12 19.5V4.5z"></path>
    <path d="M8 9.5h2M14 9.5h2M9 14h6"></path>
  {:else if name === 'sync'}
    <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"></path>
    <path d="M21 3v5h-5"></path>
    <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"></path>
    <path d="M3 21v-5h5"></path>
  {:else}
    <ellipse cx="12" cy="5.5" rx="8" ry="3"></ellipse>
    <path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"></path>
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>
  {/if}
</svg>
