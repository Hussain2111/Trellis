'use client';

import type { ServerTiming, TimedRoute } from './server';

export interface NavigationTiming {
  kind: 'navigation';
  navigationId: string;
  route: TimedRoute;
  visit: 'first' | 'repeat';
  feedback: 'pending' | 'loading' | 'page';
  clickToFeedbackMs: number;
  clickToUsableMs: number;
  server: ServerTiming;
  serverRequestFresh: boolean;
}
export interface ChatTiming {
  kind: 'chat';
  requestId: string;
  outcome: 'ok' | 'error';
  submitToFeedbackMs: number | null;
  submitToResponseMs: number;
  submitToVisibleMs: number;
}
type BrowserTiming = NavigationTiming | ChatTiming | { kind: 'initial'; server: ServerTiming };
declare global {
  interface Window {
    __trellisPerformance?: BrowserTiming[];
  }
}
const visits = new Set<TimedRoute>();
const serverRequests = new Set<string>();
let navigation: {
  id: string;
  route: TimedRoute;
  started: number;
  visit: 'first' | 'repeat';
  feedback?: NavigationTiming['feedback'];
  feedbackAt?: number;
} | null = null;
export const performanceEnabled = () => process.env.NEXT_PUBLIC_TRELLIS_PERFORMANCE === '1';

function publish(event: BrowserTiming) {
  const events = (window.__trellisPerformance ??= []);
  events.push(event);
  if (events.length > 200) events.shift();
  window.dispatchEvent(new CustomEvent('trellis:performance', { detail: event }));
}

/** An approximation to painted feedback, after a rendering opportunity. */
export function afterPaint(work: () => void): () => void {
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(work);
  });
  let second = 0;
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

export function startNavigation(route: TimedRoute) {
  if (!performanceEnabled()) return;
  navigation = {
    id: crypto.randomUUID(),
    route,
    started: performance.now(),
    visit: visits.has(route) ? 'repeat' : 'first',
  };
  performance.clearMarks('trellis.navigation.click');
  performance.clearMarks('trellis.navigation.feedback');
  performance.clearMarks('trellis.navigation.usable');
  performance.mark('trellis.navigation.click');
}

export function navigationFeedback(source: 'pending' | 'loading') {
  if (!performanceEnabled() || !navigation) return;
  const current = navigation;
  return afterPaint(() => {
    if (navigation !== current || current.feedbackAt !== undefined) return;
    current.feedback = source;
    current.feedbackAt = performance.now();
    performance.mark('trellis.navigation.feedback');
  });
}

export function pageReady(route: TimedRoute, server: ServerTiming) {
  if (!performanceEnabled()) return;
  return afterPaint(() => {
    visits.add(route);
    const serverRequestFresh = !serverRequests.has(server.requestId);
    serverRequests.add(server.requestId);
    if (serverRequests.size > 200) serverRequests.delete(serverRequests.values().next().value!);
    const current = navigation;
    if (!current || current.route !== route) {
      // A cached React tree may not need a server request. Do not invent one.
      if (!current) publish({ kind: 'initial', server });
      return;
    }
    const now = performance.now();
    publish({
      kind: 'navigation',
      navigationId: current.id,
      route,
      visit: current.visit,
      feedback: current.feedback ?? 'page',
      clickToFeedbackMs: (current.feedbackAt ?? now) - current.started,
      clickToUsableMs: now - current.started,
      server,
      serverRequestFresh,
    });
    performance.mark('trellis.navigation.usable');
    navigation = null;
  });
}

export function startChatTiming() {
  const id = crypto.randomUUID();
  const started = performance.now();
  let feedbackAt: number | null = null;
  let responseAt: number | null = null;
  return {
    requestId: id,
    feedback: () => {
      if (performanceEnabled())
        return afterPaint(() => {
          feedbackAt ??= performance.now();
        });
    },
    response: () => {
      responseAt = performance.now();
    },
    finish: (outcome: 'ok' | 'error') => {
      if (performanceEnabled())
        afterPaint(() =>
          publish({
            kind: 'chat',
            requestId: id,
            outcome,
            submitToFeedbackMs: feedbackAt === null ? null : feedbackAt - started,
            submitToResponseMs: (responseAt ?? performance.now()) - started,
            submitToVisibleMs: performance.now() - started,
          }),
        );
    },
  };
}
