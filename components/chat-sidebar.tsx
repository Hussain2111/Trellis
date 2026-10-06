'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PlusIcon, TrashIcon } from './icons';

export interface ThreadSummary {
  id: number;
  title: string | null;
  fromNote: boolean;
  updatedLabel: string;
}

/**
 * Conversations are kept, listed, and deleted on purpose.
 *
 * Before this existed the chat showed whichever thread was most recent and gave
 * you no way back to any other, so opening a note — which creates a thread —
 * looked exactly like the previous conversation being erased. Nothing was ever
 * being deleted; there was simply nowhere to see it.
 */
export function ChatSidebar({ threads, activeId }: { threads: ThreadSummary[]; activeId: number }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const deleting = useRef(new Set<number>());
  const currentActiveId = useRef(activeId);
  const mounted = useRef(true);

  useEffect(() => {
    currentActiveId.current = activeId;
  }, [activeId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Deleting used to wait on the request, then a navigation, then a full
   * re-render of a dynamic page — three server round trips before the row you
   * had already decided about left the screen. The row goes now and the request
   * follows. A failed request restores only its own row, so concurrent deletes
   * cannot undo each other. Keep the active conversation open until confirmed.
   */
  const [removed, setRemoved] = useState<number[]>([]);
  const visible = threads.filter((thread) => !removed.includes(thread.id));

  async function newChat() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/chat/threads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const { thread } = await res.json();
      router.push(`/chat?thread=${thread.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: number) {
    if (deleting.current.has(id)) return;
    deleting.current.add(id);
    setConfirming(null);
    setRemoved((ids) => [...ids, id]);
    setErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    let failure: string | null = null;
    try {
      const response = await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        failure = `Could not delete this chat (server error ${response.status}). Please try again.`;
      } else if (mounted.current) {
        // Selection may have changed while the request was pending.
        if (id === currentActiveId.current) router.push('/chat');
        router.refresh();
      }
    } catch {
      failure =
        'Could not reach the server. This chat is still listed; please try deleting it again.';
    } finally {
      deleting.current.delete(id);
      if (failure && mounted.current) {
        const message = failure;
        setRemoved((ids) => ids.filter((removedId) => removedId !== id));
        setErrors((previous) => ({ ...previous, [id]: message }));
      }
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <button
        type="button"
        onClick={() => void newChat()}
        disabled={creating}
        className="flex items-center justify-center gap-2 rounded-xl border border-rule bg-card px-3 py-2.5 text-sm font-medium transition-colors hover:border-accent disabled:opacity-50"
      >
        <PlusIcon className="size-4" />
        New chat
      </button>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {visible.map((thread) => {
          const active = thread.id === activeId;

          // A conversation is not recoverable once deleted, so the trash icon
          // asks rather than acts. Inline, in the row itself — a modal for this
          // is heavier than the decision.
          if (confirming === thread.id) {
            return (
              <li
                key={thread.id}
                className="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate text-ink-muted">Delete this chat?</span>
                <button
                  type="button"
                  onClick={() => void remove(thread.id)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-negative"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-muted"
                >
                  Keep
                </button>
              </li>
            );
          }

          return (
            <li key={thread.id} className="group relative">
              <Link
                href={`/chat?thread=${thread.id}`}
                className={`block rounded-lg py-2 pl-3 pr-9 text-sm transition-colors ${
                  active ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-paper-sunk'
                }`}
              >
                <span className="block truncate">
                  {thread.fromNote ? '📌 ' : ''}
                  {thread.title ?? 'New chat'}
                </span>
                <span className="mt-0.5 block text-xs text-ink-faint">{thread.updatedLabel}</span>
              </Link>
              <button
                type="button"
                onClick={() => setConfirming(thread.id)}
                aria-label={`Delete ${thread.title ?? 'this chat'}`}
                className="absolute right-1.5 top-2 rounded-md p-1.5 text-ink-faint opacity-0 transition-opacity hover:text-negative focus-visible:opacity-100 group-hover:opacity-100"
              >
                <TrashIcon className="size-4" />
              </button>
              {errors[thread.id] ? (
                <p role="alert" className="px-3 py-2 text-xs text-negative">
                  {errors[thread.id]}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
