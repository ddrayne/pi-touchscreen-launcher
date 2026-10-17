/**
 * Small fetch helpers that never leave a response body unread.
 *
 * Chromium hands every fetch body to the page as a mojo data pipe backed by
 * a 2 MB shared-memory segment and a file descriptor. A body that is never
 * read or cancelled keeps both until the next full garbage collection, which
 * on a quiet page may be hours away. The kiosk polls a handful of endpoints
 * every few seconds for days, so an error path that drops its body leaks
 * about a thousand segments in a working day, exhausts the renderer's file
 * descriptors and wedges it. These helpers close that door.
 */

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Cancels an unread body. Safe on consumed, locked, absent or null responses. */
export async function discardBody(response: Response | null | undefined): Promise<void> {
  const body = response?.body;
  if (!body || response.bodyUsed || body.locked) return;
  try {
    await body.cancel();
  } catch {
    // A body that is already being read or closed is not a leak.
  }
}

/** Parses an OK JSON body, or cancels the body and throws for any other status. */
export async function readJson<T>(response: Response, message: string): Promise<T> {
  if (!response.ok) {
    await discardBody(response);
    throw new HttpError(message, response.status);
  }
  return (await response.json()) as T;
}

/** For fire-and-forget requests: drain or cancel the body, swallow failures. */
export async function settle(request: Promise<Response>): Promise<void> {
  try {
    await discardBody(await request);
  } catch {
    // The caller did not care about the result; it must not leak either.
  }
}
