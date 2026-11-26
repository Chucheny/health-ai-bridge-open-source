// Test-only child preload. Every fetch goes to the drill's in-memory REST handler over IPC.
// There is deliberately no fallback to real fetch and no option to bypass the CLI's TTY check.
if (!process.send) throw new Error('Synthetic terminal proxy requires its parent drill.');
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write;
  stream.write = function (chunk: any, ...rest: any[]) {
    process.send!({ kind: 'output', stream: stream === process.stdout ? 'stdout' : 'stderr', text: String(chunk) });
    return (write as any).call(stream, chunk, ...rest);
  } as typeof stream.write;
}
globalThis.fetch = async (input, init) => {
  if (String(input).slice(0, 'https://bridge.invalid/'.length) !== 'https://bridge.invalid/') throw new Error('external network forbidden');
  process.channel?.ref();
  try {
    return await new Promise<Response>((resolve, reject) => {
      process.once('message', (message: any) => {
        if (message.kind !== 'response' || message.error) reject(new Error('synthetic transport failure'));
        else resolve(new Response(message.body, { status: message.status, headers: message.headers }));
      });
      process.send!({ kind: 'fetch', url: String(input), method: init?.method, redirect: init?.redirect,
        headers: [...new Headers(init?.headers)], body: init?.body });
    });
  } finally { process.channel?.unref(); }
};
process.channel?.unref();
