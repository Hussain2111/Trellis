'use client';

import { useEffect, useRef, useState } from 'react';
import { Markdown } from './markdown';
import { performanceEnabled, startChatTiming } from '@/lib/performance/browser';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  dropped?: number;
}

/**
 * No streaming, by design.
 *
 * The answer is validated before it is rendered, because a figure the database
 * cannot back is dropped rather than caveated — and you cannot un-send a token.
 * So the wait is honest: tool activity is visible, then the answer arrives
 * whole.
 */
export function ChatPanel({
  threadId,
  initial,
  fromNote = false,
}: {
  threadId: number;
  initial: Message[];
  /** Whether this thread was opened from a dashboard note. Display only — the
      server reads the card reference off the thread row rather than from here. */
  fromNote?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>(initial);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const chatTiming = useRef<ReturnType<typeof startChatTiming> | null>(null);

  useEffect(() => {
    if (pending) return chatTiming.current?.feedback();
  }, [pending]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pending]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    const timing = startChatTiming();
    chatTiming.current = timing;
    let outcome: 'ok' | 'error' = 'error';

    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setPending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(performanceEnabled() ? { 'x-trellis-request-id': timing.requestId } : {}),
        },
        body: JSON.stringify({ threadId, message: text }),
      });

      // A failing route can answer with something that is not JSON at all — an
      // empty 500, a proxy's error page. Parsing that used to throw into the
      // catch below, which reports a network problem, and a server-side fault
      // then read as "your connection is down". They are different problems
      // and only one of them is worth retrying by hand.
      const body: {
        answer?: string;
        dropped?: number;
        error?: string;
        message?: string;
      } | null = await res.json().catch(() => null);
      timing.response();

      if (!res.ok || !body) {
        setError(
          body?.message ??
            `The server returned an error (${res.status}). It has been logged with the details.`,
        );
        // Not lost. The question goes back in the box so it can be sent again
        // when the window rolls, instead of having to be retyped.
        if (body?.error === 'quota') {
          setInput(text);
          setMessages((m) => m.slice(0, -1));
        }
        return;
      }

      setMessages((m) => [
        ...m,
        { role: 'assistant', content: body.answer ?? '', dropped: body.dropped },
      ]);
      outcome = 'ok';
    } catch {
      // Genuinely unreachable: the request never completed. Everything the
      // server said, including that it broke, is handled above.
      setError('Could not reach the server — the request never completed.');
    } finally {
      setPending(false);
      timing.finish(outcome);
    }
  }

  return (
    <div className="flex min-h-[60vh] flex-col">
      <div className="flex-1 space-y-4">
        {messages.length === 0 ? (
          <div className="rounded-xl border border-rule bg-card px-5 py-8 text-center">
            <p className="text-sm font-medium text-ink-muted">Ask about your account</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-faint">
              {fromNote
                ? 'Ask about the note above — it will look up what that note was based on.'
                : 'Every number comes from your own data or it doesn’t get said.'}
            </p>
          </div>
        ) : null}

        {messages.map((message, i) => (
          <div
            key={i}
            className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                message.role === 'user' ? 'bg-accent-soft text-ink' : 'border border-rule bg-card'
              }`}
            >
              {message.role === 'assistant' ? (
                <Markdown text={message.content} />
              ) : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
              {message.dropped ? (
                <p className="mt-2 border-t border-rule pt-2 text-xs text-ink-faint">
                  {message.dropped} line{message.dropped === 1 ? '' : 's'} removed — they stated
                  figures that weren&rsquo;t in what the queries returned, and this app drops those
                  rather than showing them.
                </p>
              ) : null}
            </div>
          </div>
        ))}

        {pending ? (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-rule bg-card px-4 py-3 text-sm text-ink-faint">
              Checking your data…
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-rule bg-card px-4 py-3 text-sm text-negative">
            {error}
          </div>
        ) : null}

        <div ref={endRef} />
      </div>

      <form
        className="sticky bottom-20 mt-6 flex gap-2 sm:bottom-0"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your posts…"
          className="flex-1 rounded-full border border-rule bg-card px-5 py-3 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={pending || input.trim().length === 0}
          className="rounded-full bg-accent px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}
