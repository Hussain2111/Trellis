import { deleteThread, selfAccountId } from '@/lib/chat/threads';
import { respond } from '@/lib/api/respond';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const handler = async () => {
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ error: 'no_account' }, { status: 409 });

    const id = Number((await params).id);
    if (!Number.isInteger(id)) return Response.json({ error: 'bad request' }, { status: 400 });

    // Scoped to the account, not just the id — the delete is a filter, not a
    // lookup followed by a trusting removal.
    await deleteThread(accountId, id);
    return Response.json({ ok: true });
  };
  return respond(handler, { route: '/api/chat/threads/[id]', request });
}
