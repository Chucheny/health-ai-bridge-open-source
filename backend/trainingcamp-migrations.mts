import { readFile } from 'node:fs/promises';
import { CAPACITY_TABLES, TRAININGCAMP_CAPACITY_TABLES } from './capacity.mts';
import type { Database, Sql } from './database.mts';
import { ensureRuntimeRole, RUNTIME_ROLE, verifyRuntimeGrants } from './runtime-role.mts';

const migrations = ['002_trainingcamp_activities.sql', '003_trainingcamp_sleep.sql'] as const;
const supportedTables: readonly (readonly string[])[] = [
  CAPACITY_TABLES,
  [...CAPACITY_TABLES, TRAININGCAMP_CAPACITY_TABLES[0]],
  [...CAPACITY_TABLES, ...TRAININGCAMP_CAPACITY_TABLES],
];

export function assertTrainingCampMigrationTarget(adminValue: string, runtimeValue: string) {
  const admin = new URL(adminValue), runtime = new URL(runtimeValue);
  const project = /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(admin.username))?.[1];
  // Both connections must name the same managed project and database. Query options can override a URL target.
  if (!project || decodeURIComponent(runtime.username) !== RUNTIME_ROLE + '.' + project ||
      ![admin, runtime].every(url => ['postgres:', 'postgresql:'].includes(url.protocol) &&
        url.pathname === '/postgres' && url.hostname && url.password && !url.search && !url.hash) ||
      admin.hostname !== runtime.hostname || (admin.port || '5432') !== (runtime.port || '5432')) {
    throw new Error('Migration connections do not identify the same project');
  }
}

async function migrationStage(sql: Sql) {
  const relations = (await sql.query(`SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='health_bridge' AND c.relkind IN ('r','p','f','v','m')`)).rows;
  const stage = supportedTables.findIndex(tables => relations.length === tables.length &&
    relations.every(row => row.kind === 'r' && row.rls && tables.includes(row.name)));
  if (stage < 0) throw new Error('Unexpected migration schema');
  return stage;
}

async function reviewedStatements(filename: typeof migrations[number]) {
  const script = await readFile(new URL('./migrations/' + filename, import.meta.url), 'utf8');
  const body = /^(?:--[^\r\n]*\r?\n)*BEGIN;\s*([\s\S]+?)\s*COMMIT;\s*$/.exec(script)?.[1];
  if (!body) throw new Error('Unexpected migration transaction wrapper');
  // The two reviewed files use simple additive statements without internal semicolons.
  // Reject statements outside that set so the outer transaction owns every commit.
  const statements = body.split(';').map(statement => statement.trim()).filter(Boolean);
  if (!statements.length || !statements.every(statement =>
    /^(?:CREATE (?:TABLE|INDEX) |REVOKE ALL ON |ALTER TABLE [a-z_.]+ ENABLE ROW LEVEL SECURITY$)/.test(statement))) {
    throw new Error('Unexpected reviewed migration statement');
  }
  return statements;
}

/** Apply pending reviewed migrations and validate the resulting grants before the single commit. */
export function migrateTrainingCamp(admin: Database, runtimePassword: string) {
  return admin.transaction(async sql => {
    await sql.query("SET LOCAL lock_timeout = '5s'");
    const lock = (await sql.query(`SELECT pg_try_advisory_xact_lock(
      hashtext('health_bridge'), hashtext('trainingcamp_migrations')) AS acquired`)).rows[0];
    if (lock?.acquired !== true) throw new Error('Another Training Camp migration is active');
    const stage = await migrationStage(sql);
    const pending = migrations.slice(stage);
    for (const migration of pending) {
      for (const statement of await reviewedStatements(migration)) await sql.query(statement);
    }
    await ensureRuntimeRole(sql, runtimePassword);
    const state = await verifyRuntimeGrants(sql);
    if (state.rlsTables !== supportedTables[2].length) throw new Error('Training Camp migration incomplete');
    return { appliedMigrations: pending, rlsTables: state.rlsTables };
  });
}
