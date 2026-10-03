import { createFileRoute, useRouterState } from '@tanstack/react-router';
import PlynthSite from '../components/PlynthSite';
import { plynthHead } from '../site/head';

export const Route = createFileRoute('/$')({ component: PlynthPage, head: () => plynthHead });

function PlynthPage() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return <PlynthSite pathname={pathname} />;
}
