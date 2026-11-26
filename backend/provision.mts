// Operator-only bootstrap. Not part of the deployed function or Android APK.
// Run only against the chosen, migrated external PostgreSQL database.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { hash, TYPES } from './protocol.mts';

let db: Database | undefined;
try {
  const [, , base, typeList, ownerArg] = process.argv;
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
  const types = typeList?.split(',');
  if (!types?.length || types.some(t => !(TYPES as readonly string[]).includes(t))) throw new Error();
  const connection = process.env.HEALTH_ADMIN_DATABASE_URL;
  if (!connection) throw new Error();
  const privateRoot = resolve('private');
  await mkdir(privateRoot, { mode: 0o700, recursive: true });
  if ((await lstat(privateRoot)).isSymbolicLink()) throw new Error();
  const owner = ownerArg ?? randomUUID(), source = randomUUID(), token = randomBytes(32).toString('base64url');
  if (!/^[a-f0-9-]{36}$/i.test(owner)) throw new Error();
  const directory = resolve(privateRoot, `device-${source}`);
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
    if (!identity) throw new Error();
    // Windows ignores POSIX modes. This new credential directory must be private BEFORE writing secrets.
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  }
  const file = resolve(directory, 'config.json');
  db = postgresDatabase(connection, process.env.HEALTH_DATABASE_CA);
  await db.transaction(async sql => {
    await sql.query('INSERT INTO health_bridge.accounts (id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
    await sql.query(`INSERT INTO health_bridge.device_tokens (token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES ($1,$2,$3,$4,$5)`, [hash(token), owner, source, ['sync', 'read', 'revoke'], types]);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, baseUrl: url.origin, ownerId: owner, sourceId: source,
      token, allowedTypes: types }, null, 2), { flag: 'wx', mode: 0o600 });
  });
  console.log('Device credential saved under private/. No secret was printed. Android import is not yet implemented.');
} catch {
  console.error('Provisioning did not complete. Check the private configuration and database setup; no raw error or secret was logged.');
  process.exitCode = 1;
} finally { await db?.close?.(); }
