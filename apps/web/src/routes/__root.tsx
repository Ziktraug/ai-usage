import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/solid-router';
import type { JSX } from 'solid-js';
import { HydrationScript } from 'solid-js/web';
import { SourceControlProvider } from '../source-control-context';
import '../index.css';

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <meta content="light dark" name="color-scheme" />
        <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
        <script>
          {`try{var theme=localStorage.getItem('ai-usage-theme');if(theme==='light'||theme==='dark'){document.documentElement.dataset.theme=theme;document.querySelector('meta[name="color-scheme"]')?.setAttribute('content',theme)}}catch(_){}`}
        </script>
        <HydrationScript />
      </head>
      <body>
        <HeadContent />
        {props.children}
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRoute({
  shellComponent: RootDocument,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'ai-usage report' },
    ],
  }),
  errorComponent: (props) => <pre>{props.error instanceof Error ? props.error.message : String(props.error)}</pre>,
  component: RootRoute,
});

function RootRoute() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 10 * 60 * 1000,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: (query) => (query.state.data === null ? 0 : Number.POSITIVE_INFINITY),
      },
    },
  });

  return (
    <QueryClientProvider client={queryClient}>
      <SourceControlProvider>
        <Outlet />
      </SourceControlProvider>
    </QueryClientProvider>
  );
}
