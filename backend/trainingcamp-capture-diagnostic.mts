import { MAX_TRAININGCAMP_CAPTURE_BYTES, verifyTrainingCampSleepCapture } from './trainingcamp-capture.mts';

// Capture on stdin; caller's independently chosen authorization bounds on argv. No file writes or network.
try {
  if (process.argv.length !== 4) throw new Error();
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.byteLength;
    if (size > MAX_TRAININGCAMP_CAPTURE_BYTES) throw new Error();
    chunks.push(bytes);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const result = verifyTrainingCampSleepCapture(JSON.parse(text), { start: process.argv[2], end: process.argv[3] });
  console.log(JSON.stringify({ schemaVersion: result.schemaVersion, source: result.source, counts: result.counts,
    requestedWindow: result.requestedWindow, captureValidation: result.captureValidation,
    sourceCompleteness: result.sourceCompleteness, healthValuesPrinted: false, liveReadingVerified: false }));
} catch { console.error('{"error":"invalid_trainingcamp_capture"}'); process.exitCode = 1; }
