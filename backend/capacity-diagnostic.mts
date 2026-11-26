// Operator-only metadata command. Never import this entry point into the public API.
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { inspectCapacity } from './capacity.mts';

async function reportCapacity() {
  let database: Database | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--include-trainingcamp')) throw new Error();
    const url = process.env.HEALTH_DATABASE_URL;
    if (!url) throw new Error();
    database = postgresDatabase(url, process.env.HEALTH_DATABASE_CA);
    return await inspectCapacity(database, undefined, { includeTrainingCamp: args[0] === '--include-trainingcamp' });
  } finally { await database?.close?.(); }
}

try {
  const report = await reportCapacity();
  console.log(JSON.stringify(report));
  if (!report.complete) process.exitCode = 2;
} catch {
  // Configuration, TLS, SQL and close errors may contain connection secrets.
  console.error(JSON.stringify({ error: 'CAPACITY_INSPECTION_FAILED' }));
  process.exitCode = 1;
}
