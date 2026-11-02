// Covers never compete with each other in an unbounded burst. No bytes or account state are cached.
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (active >= 2) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = waiting.indexOf(ready);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
      };
      waiting.push(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  } else active++;
  // A released slot is transferred directly to the next queued request.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Only retry explicit read-side rate limits, never writes, auth, integrity or parser failures. */
export async function readThumbnail<T>(signal: AbortSignal, load: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const release = await acquire(signal);
    try {
      signal.throwIfAborted();
      return await load();
    } catch (cause) {
      if (
        signal.aborted ||
        attempt >= 2 ||
        !cause ||
        typeof cause !== "object" ||
        !("status" in cause) ||
        cause.status !== 429
      )
        throw cause;
    } finally {
      release();
    }
    await pause(attempt === 0 ? 1000 : 3000, signal);
  }
}
