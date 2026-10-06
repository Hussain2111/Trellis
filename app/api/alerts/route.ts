import { currentAlerts } from '@/lib/alerts';
import { respond } from '@/lib/api/respond';
import { selfAccountId } from '@/lib/chat/threads';

export const dynamic = 'force-dynamic';

/**
 * One request serves both the banners and the nav badge.
 *
 * It is fetched after first paint rather than awaited before it — the alerts
 * matter, but not enough to hold the whole app behind a database round trip on
 * every navigation.
 */
export async function GET(request: Request): Promise<Response> {
  const handler = async () => {
    const accountId = await selfAccountId();
    if (!accountId) return Response.json({ alerts: [], overdue: 0 });
    return Response.json(await currentAlerts(accountId));
  };
  return respond(handler, { route: '/api/alerts', request });
}
