/**
 * A route that throws before it can answer still has to answer.
 *
 * Next turns an uncaught error in a route handler into a 500 with an EMPTY
 * body and no content type. The caller's `await response.json()` then throws
 * too, and a client that treats that as a failed request reports a network
 * problem — so a misconfigured environment variable on the server surfaced in
 * the browser as "Could not reach the server", which sent the search in exactly
 * the wrong direction.
 *
 * Anything reached before a handler's own try block — parsing the environment,
 * resolving the account, a query against a column a migration has not created
 * yet — is inside this one.
 */
import { timedResponse, type TimedRoute } from '../performance/server';

export async function respond(
  handler: () => Promise<Response>,
  timing?: { route: TimedRoute; request: Request },
): Promise<Response> {
  if (timing) return timedResponse(timing.route, timing.request, () => respond(handler));
  try {
    return await handler();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[route]', message);
    return Response.json(
      {
        error: 'server_error',
        // The real message. This app has one user, who is also the person who
        // would otherwise be reading server logs to find out what broke.
        message,
      },
      { status: 500 },
    );
  }
}
