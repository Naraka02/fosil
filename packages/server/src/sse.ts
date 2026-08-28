import type { Writable } from "node:stream";

export class StreamStopped extends Error {}

/** At most one frame is handed to the writable before its backpressure settles. */
export async function writeSseFrame(output: Writable, frame: string, signal: AbortSignal, maxBytes: number, drainMs: number): Promise<void> {
  if (signal.aborted || output.destroyed || Buffer.byteLength(frame) > maxBytes) throw new StreamStopped();
  // Install listeners before write(): a synchronous writable may emit immediately.
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      output.off("close", stop).off("error", stop).off("drain", drained);
      error ? reject(error) : resolve();
    };
    const stop = () => done(new StreamStopped());
    const drained = () => done();
    signal.addEventListener("abort", stop, { once: true });
    output.once("close", stop).once("error", stop).once("drain", drained);
    try {
      if (output.write(frame)) done();
      else if (!settled) timer = setTimeout(stop, drainMs);
    } catch { stop(); }
  });
}

export function streamPause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
