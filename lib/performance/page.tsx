import type { ReactNode } from 'react';
import { PageReady } from '@/components/performance-markers';
import { timed, type TimedRoute } from './server';

/** This measures page preparation, not Next's later rendering/serialization. */
export async function preparePage(route: TimedRoute, work: () => Promise<ReactNode>) {
  const { value, metadata } = await timed(route, work);
  return (
    <>
      {value}
      {metadata ? <PageReady route={route} metadata={metadata} /> : null}
    </>
  );
}
