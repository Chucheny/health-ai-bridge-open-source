import { postgresDatabase } from './database.mts';
import { ensureRuntimeRole, RUNTIME_ROLE, verifyRuntimeRole } from './runtime-role.mts';
import type { Database } from './database.mts';
import { assertTrainingCampMigrationTarget, migrateTrainingCamp } from './trainingcamp-migrations.mts';

let admin: Database | undefined, runtime: Database | undefined;
const args = process.argv.slice(2);
const applyMigrations = args.length === 1 && args[0] === '--apply-trainingcamp-migrations';
let failure = applyMigrations ? 'TRAININGCAMP_MIGRATION_NOT_STARTED' : 'RUNTIME_BOOTSTRAP_NOT_VERIFIED';
try {
  if (args.length && !applyMigrations) throw new Error();
  const adminUrl = process.env.HEALTH_ADMIN_DATABASE_URL;
  const runtimeUrl = process.env.HEALTH_RUNTIME_DATABASE_URL;
  if (!adminUrl || !runtimeUrl) throw new Error();
  const url = new URL(runtimeUrl);
  if (!decodeURIComponent(url.username).startsWith(RUNTIME_ROLE + '.')) throw new Error();
  if (applyMigrations) assertTrainingCampMigrationTarget(adminUrl, runtimeUrl);
  const ca = process.env.HEALTH_DATABASE_CA, password = decodeURIComponent(url.password);
  admin = postgresDatabase(adminUrl, ca);
  if (applyMigrations) {
    runtime = postgresDatabase(runtimeUrl, ca);
    await runtime.transaction(async sql => {
      if ((await sql.query('SELECT current_user AS role')).rows[0]?.role !== RUNTIME_ROLE) throw new Error();
    });
    failure = 'TRAININGCAMP_MIGRATION_OUTCOME_UNVERIFIED';
    const migrated = await migrateTrainingCamp(admin, password);
    failure = 'TRAININGCAMP_MIGRATION_COMMITTED_RUNTIME_NOT_VERIFIED';
    const result = await runtime.transaction(verifyRuntimeRole);
    if (result.rlsTables !== migrated.rlsTables) throw new Error();
    console.log(JSON.stringify({ runtimeTls: true, ...result, appliedMigrations: migrated.appliedMigrations }));
  } else {
    await admin.transaction(sql => ensureRuntimeRole(sql, password));
    runtime = postgresDatabase(runtimeUrl, ca);
    const result = await runtime.transaction(verifyRuntimeRole);
    console.log(JSON.stringify({ runtimeTls: true, ...result }));
  }
} catch {
  console.error(failure); process.exitCode = 1;
} finally { await runtime?.close?.(); await admin?.close?.(); }
