import { z } from 'zod';
import type { Database } from './database.mts';

export const CAPACITY_TABLES = ['accounts', 'device_tokens', 'health_records', 'samples',
  'sleep_stages', 'sync_batches', 'sync_streams'] as const;
export const TRAININGCAMP_CAPACITY_TABLES = ['trainingcamp_activities', 'trainingcamp_sleep_snapshots',
  'trainingcamp_sleep_records'] as const;
const allTables = [...CAPACITY_TABLES, ...TRAININGCAMP_CAPACITY_TABLES] as const;
type CapacityTable = typeof allTables[number];

export type CapacityReport = {
  schemaVersion: 1;
  coverageProfile: 'core' | 'core_and_trainingcamp';
  observedAt: string;
  readOnly: true;
  schemaPresent: boolean;
  complete: boolean;
  missingTables: CapacityTable[];
  databaseBytes: string;
  selectedTablesBytes: string;
  selectedTableDataBytes: string;
  selectedIndexBytes: string;
  tables: { table: CapacityTable; tableBytes: string; indexBytes: string; totalBytes: string }[];
};

const bytes = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => value.length < 19 || value <= '9223372036854775807');
const metaSchema = z.strictObject({
  database_bytes: bytes, read_only: z.literal('on'), schema_present: z.boolean(),
});
const tableSchema = z.strictObject({
  table_name: z.enum(allTables), table_bytes: bytes, index_bytes: bytes,
});

/** Physical-size observations of selected tables, never their row contents or counts. */
export async function inspectCapacity(database: Database, now: () => Date = () => new Date(),
  options: { includeTrainingCamp?: boolean } = {}): Promise<CapacityReport> {
  try {
    const expected: readonly CapacityTable[] = options.includeTrainingCamp ? allTables : CAPACITY_TABLES;
    const observedAt = Date.prototype.toISOString.call(now());
    return await database.transaction<CapacityReport>(async sql => {
      await sql.query('SET TRANSACTION READ ONLY');
      await sql.query("SET LOCAL statement_timeout = '5s'");
      await sql.query("SET LOCAL lock_timeout = '2s'");
      const [meta] = z.array(metaSchema).length(1).parse((await sql.query(`SELECT
        pg_catalog.pg_database_size(pg_catalog.current_database())::text AS database_bytes,
        pg_catalog.current_setting('transaction_read_only') AS read_only,
        EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS schema_present`,
      ['health_bridge'])).rows);
      const rows = z.array(tableSchema).max(expected.length).parse((await sql.query(`SELECT
        c.relname AS table_name,
        pg_catalog.pg_table_size(c.oid)::text AS table_bytes,
        pg_catalog.pg_indexes_size(c.oid)::text AS index_bytes
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND c.relname=ANY($2::text[])
        ORDER BY c.relname`, ['health_bridge', [...expected]])).rows);
      const seen = new Set<CapacityTable>();
      let tableData = 0n, indexes = 0n;
      const tables = rows.map(row => {
        if (seen.has(row.table_name) || !expected.includes(row.table_name)) throw new Error();
        seen.add(row.table_name);
        const tableBytes = BigInt(row.table_bytes), indexBytes = BigInt(row.index_bytes);
        tableData += tableBytes;
        indexes += indexBytes;
        return { table: row.table_name, tableBytes: row.table_bytes, indexBytes: row.index_bytes,
          totalBytes: (tableBytes + indexBytes).toString() };
      });
      const missingTables = expected.filter(table => !seen.has(table));
      return { schemaVersion: 1, coverageProfile: options.includeTrainingCamp ? 'core_and_trainingcamp' : 'core',
        observedAt, readOnly: true, schemaPresent: meta.schema_present,
        complete: meta.schema_present && missingTables.length === 0, missingTables,
        databaseBytes: meta.database_bytes, selectedTablesBytes: (tableData + indexes).toString(),
        selectedTableDataBytes: tableData.toString(), selectedIndexBytes: indexes.toString(), tables };
    });
  } catch {
    // Neither database errors nor malformed metadata may escape into operator output.
    throw new Error('Capacity inspection unavailable');
  }
}
