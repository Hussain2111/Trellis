'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { loadAlerts } from '@/lib/client/alerts';
import { CalendarIcon, ChatIcon, DashboardIcon, SettingsIcon } from './icons';
import { navigationFeedback, startNavigation } from '@/lib/performance/browser';

/**
 * Three destinations, as icons.
 *
 * The rail is narrow on purpose: the chat needs a sidebar of its own for its
 * threads, and two columns of text labels down the left of a phone-first app is
 * one column too many. Labels are still there for screen readers, still there
 * on hover, and still spelled out on mobile where there is width to spare and
 * no hover to reveal them.
 */
const ITEMS = [
  { href: '/', label: 'Dashboard', Icon: DashboardIcon },
  { href: '/chat', label: 'Chat', Icon: ChatIcon },
  { href: '/calendar', label: 'Calendar', Icon: CalendarIcon },
] as const;

/**
 * A clicked link has to react on the next frame, whatever the server is doing.
 *
 * Every route here reads the database on request, so there is real latency
 * between the click and the new page. `loading.tsx` covers the page area; this
 * covers the thing the finger actually landed on, so the nav never looks like
 * it ignored you.
 */
function Pending() {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (pending) return navigationFeedback('pending');
  }, [pending]);
  if (!pending) return null;
  return (
    <span
      aria-hidden
      className="absolute right-1.5 top-1.5 size-1.5 animate-pulse rounded-full bg-accent"
    />
  );
}

export function Nav() {
  const pathname = usePathname();
  const overdue = useOverdueCount();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-card sm:inset-y-0 sm:right-auto sm:w-16 sm:border-r sm:border-t-0"
      aria-label="Main"
    >
      {/* No wordmark linking home. The dashboard icon already goes there, and
          two controls doing one job is one control too many in a rail this
          narrow. */}
      <div className="hidden h-6 sm:block" />

      <ul className="flex sm:flex-col sm:items-center sm:gap-1">
        {ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <li key={href} className="flex-1 sm:flex-none">
              <Link
                href={href}
                onClick={(event) => {
                  if (
                    event.button === 0 &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey &&
                    pathname !== href
                  )
                    startNavigation(href);
                }}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={`group relative flex flex-col items-center gap-1 px-2 py-3 text-[11px] font-medium transition-colors sm:size-11 sm:justify-center  sm:rounded-xl sm:p-0 ${
                  active ? 'text-accent sm:bg-accent-soft' : 'text-ink-faint hover:text-ink'
                }`}
              >
                <span className="relative">
                  <Icon />
                  {href === '/calendar' && overdue > 0 ? (
                    <span className="absolute -right-2 -top-1.5 inline-flex min-w-[1.05rem] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
                      {overdue}
                    </span>
                  ) : null}
                </span>
                <span className="sm:sr-only">{label}</span>
                <Pending />
              </Link>
            </li>
          );
        })}

        <li className="flex-1 sm:mt-auto sm:flex-none sm:pb-4">
          <Link
            href="/settings"
            onClick={(event) => {
              if (
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey &&
                pathname !== '/settings'
              )
                startNavigation('/settings');
            }}
            title="Settings"
            className={`group relative flex flex-col items-center gap-1 px-2 py-3 text-[11px] font-medium transition-colors sm:size-11 sm:justify-center sm:rounded-xl sm:p-0 ${
              pathname === '/settings'
                ? 'text-accent sm:bg-accent-soft'
                : 'text-ink-faint hover:text-ink'
            }`}
          >
            <SettingsIcon />
            <span className="sm:sr-only">Settings</span>
            <Pending />
          </Link>
        </li>
      </ul>
    </nav>
  );
}

/**
 * Fetched after the shell is on screen rather than awaited before it, and
 * shared with the alert banners — the badge and the banners are two readings of
 * one answer, so they are one request.
 */
function useOverdueCount(): number {
  const [overdue, setOverdue] = useState(0);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;
    void loadAlerts(pathname).then((result) => {
      if (!cancelled) setOverdue(result.overdue);
    });
    return () => {
      cancelled = true;
    };
    // Re-read on navigation, so adding or posting a draft updates the badge.
  }, [pathname]);

  return overdue;
}
