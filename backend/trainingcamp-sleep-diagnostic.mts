import { inspectTrainingCampSleep, MAX_TRAININGCAMP_INPUT_BYTES, parseTrainingCampJson } from './trainingcamp-semantics.mts';

// stdin only; no account, environment configuration, network, file writes or health-value output.
try {
  if (process.argv.length !== 2) throw new Error();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.byteLength;
    if (size > MAX_TRAININGCAMP_INPUT_BYTES) throw new Error();
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const result = inspectTrainingCampSleep(parseTrainingCampJson(text));
  console.log(JSON.stringify({ schemaVersion: result.schemaVersion, source: result.source,
    counts: result.counts, sourceCompleteness: result.sourceCompleteness, scope: result.scope,
    healthValuesPrinted: false, liveReadingVerified: false }));
} catch {
  console.error('{"error":"invalid_trainingcamp_input"}'); process.exitCode = 1;
}
