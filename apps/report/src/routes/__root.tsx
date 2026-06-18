import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/solid-router';
import type { JSX } from 'solid-js';
import { HydrationScript } from 'solid-js/web';
import '../index.css';

function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
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
  component: () => <Outlet />,
});
