import { createFileRoute } from '@tanstack/solid-router';

export const Route = createFileRoute('/skills/projects/$projectKey')({
  component: () => null,
});
