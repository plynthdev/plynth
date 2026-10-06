// Anvil on a port the OS picks (--port 0), read back from its "Listening on" line. A fixed or random port in a
// shared range can already be taken (another test file, another checkout's run, a CI job on the same host):
// anvil then exits, and a readiness probe on that port happily talks to someone else's chain.
export type Anvil = { proc: ReturnType<typeof Bun.spawn>; rpc: string; port: number; stop: () => Promise<void> };

export async function spawnAnvil(extra: string[] = [], timeoutMs = 60_000): Promise<Anvil> {
  const proc = Bun.spawn(["anvil", "--port", "0", ...extra], { stdout: "pipe", stderr: "ignore" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  let port: number | undefined;
  while (port === undefined) {
    const left = deadline - Date.now();
    const next = left > 0 ? await Promise.race([reader.read(), Bun.sleep(left).then(() => null)]) : null;
    if (next === null) {
      proc.kill();
      throw new Error(`anvil did not report a port within ${timeoutMs} ms`);
    }
    const { value, done } = next;
    if (done) throw new Error(`anvil exited before listening (code ${await proc.exited}): ${buf.slice(-500)}`);
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/Listening on [^\s:]+:(\d+)/);
    if (m) port = Number(m[1]);
  }
  // Keep draining stdout (anvil logs every request) so a full pipe never blocks it.
  void (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {}
  })();
  return {
    proc,
    port,
    rpc: `http://127.0.0.1:${port}`,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}
