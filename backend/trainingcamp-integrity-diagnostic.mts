// Operator-only. Explicit scope on stdin; restricted DB connection on environment, never argv.
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { inspectTrainingCampIntegrity } from './trainingcamp-integrity.mts';

let database: Database | undefined;
try {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.byteLength;
    if (size > 2048) throw new Error(); chunks.push(bytes);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (process.argv.length !== 2 || !process.env.HEALTH_DATABASE_URL) throw new Error();
  database = postgresDatabase(process.env.HEALTH_DATABASE_URL, process.env.HEALTH_DATABASE_CA);
  const report = await inspectTrainingCampIntegrity(database, input);
  console.log(JSON.stringify(report));
  if (!report.complete || report.status === 'fail') process.exitCode = 2;
} catch {
  console.error('{"error":"TRAININGCAMP_INTEGRITY_UNAVAILABLE"}'); process.exitCode = 1;
} finally { await database?.close?.().catch(() => {}); }
