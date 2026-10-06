import { z } from 'zod';
import { respond } from '@/lib/api/respond';
import { selfAccountId } from '@/lib/chat/threads';
import { createEntry, listEntries } from '@/lib/calendar/entries';
import { riyadhInstant } from '@/lib/time';

export const dynamic = 'force-dynamic';

const entrySchema = z.object({
  // A Riyadh day and a Riyadh wall-clock time, converted on the server.
  // `new Date('2026-09-01T18:00')` in a browser means 18:00 wherever that
  // browser is, which is not what the form says and not what anything else in
  // this app assumes. `scheduledFor` stays accepted for a caller that already
  // holds a real instant.
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  timeOfDay: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  scheduledFor: z.string().min(1).optional(),
  format: z.enum(['image', 'carousel', 'reel', 'video']).optional(),
  title: z.string().max(200).optional(),
  hook: z.string().max(500).optional(),
  caption: z.string().max(4000).optional(),
  hashtags: z.array(z.string()).optional(),
  notes: z.string().max(2000).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const handler = async () => {
    // The overdue count moved to /api/alerts, which serves the banners and the
    // nav badge from one request. Two endpoints answering the same question is
    // two places for the answer to drift.
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ entries: [] });
    return Response.json({ entries: await listEntries(accountId) });
  };
  return respond(handler, { route: '/api/calendar', request });
}

export async function POST(request: Request): Promise<Response> {
  const handler = async () => {
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ error: 'no_account' }, { status: 409 });

    const parsed = entrySchema.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: 'bad request' }, { status: 400 });

    const { scheduledFor, day, timeOfDay, ...rest } = parsed.data;
    const when = day ? riyadhInstant(day, timeOfDay) : scheduledFor ? new Date(scheduledFor) : null;
    if (!when) return Response.json({ error: 'no date given' }, { status: 400 });

    const entry = await createEntry(accountId, { ...rest, scheduledFor: when });
    return Response.json({ entry });
  };
  return respond(handler, { route: '/api/calendar', request });
}
