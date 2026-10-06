import { z } from 'zod';
import { respond } from '@/lib/api/respond';
import { createThread, createThreadFromCard, listThreads, selfAccountId } from '@/lib/chat/threads';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const handler = async () => {
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ threads: [] });
    return Response.json({ threads: await listThreads(accountId) });
  };
  return respond(handler, { route: '/api/chat/threads', request });
}

const bodySchema = z.object({ sourceCardId: z.number().int().optional() });

export async function POST(request: Request): Promise<Response> {
  const handler = async () => {
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ error: 'no_account' }, { status: 409 });

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    const sourceCardId = parsed.success ? parsed.data.sourceCardId : undefined;

    // A thread opened from a note starts with the note in it. A thread opened
    // from the New chat button starts empty.
    const thread = sourceCardId
      ? await createThreadFromCard(accountId, sourceCardId)
      : await createThread(accountId);

    return Response.json({ thread });
  };
  return respond(handler, { route: '/api/chat/threads', request });
}
