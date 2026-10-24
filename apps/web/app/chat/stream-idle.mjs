/**
 * A chat stream that stops sending bytes must not leave the screen on
 * "Atlas · 1 step" with a stop button forever. The server sends a keep-alive
 * comment every few seconds while a turn is still working (see
 * KEEP_ALIVE_MS in app/api/chat/route.ts), so silence well past that means
 * the connection or the turn is dead, and the reader gives up.
 */

/** How long a chat stream may send nothing at all before it counts as stopped. */
export const STREAM_IDLE_MS = 45_000;

export class StreamIdleError extends Error {
  constructor() {
    super("The reply stream stopped responding.");
    this.name = "StreamIdleError";
  }
}

/**
 * reader.read(), or a StreamIdleError when nothing arrives within `idleMs`.
 * On timeout the reader is cancelled so the connection is released.
 * @template T
 * @param {ReadableStreamDefaultReader<T>} reader
 * @param {number} [idleMs]
 * @returns {Promise<ReadableStreamReadResult<T>>}
 */
export function readWithIdleTimeout(reader, idleMs = STREAM_IDLE_MS) {
  let timer;
  const idle = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: cancelling settles the pending read as "done", which
      // would otherwise win the race and read as an ordinary end of stream.
      reject(new StreamIdleError());
      reader.cancel().catch(() => undefined);
    }, idleMs);
  });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}
