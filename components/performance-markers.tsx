'use client';

import { useEffect } from 'react';
import { navigationFeedback, pageReady } from '@/lib/performance/browser';
import type { ServerTiming, TimedRoute } from '@/lib/performance/server';

export function PageReady({ route, metadata }: { route: TimedRoute; metadata: ServerTiming }) {
  useEffect(() => pageReady(route, metadata), [route, metadata]);
  return (
    <span hidden data-performance-ready={route} data-performance-request={metadata.requestId} />
  );
}

export function LoadingFeedback() {
  useEffect(() => navigationFeedback('loading'), []);
  return null;
}
