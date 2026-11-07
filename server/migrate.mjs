/**
 * Apply SQL migrations in order against DATABASE_URL.
 * Usage: DATABASE_URL=postgres://... npm run migrate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL to a PostgreSQL connection string.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'db', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const pg = await import('pg');
const client = new pg.default.Client({ connectionString: url });
await client.connect();
await client.query(`
  create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )
`);

for (const file of files) {
  const id = file;
  const done = await client.query(`select 1 from schema_migrations where id = $1`, [id]);
  if (done.rowCount) {
    console.log('skip', id);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  console.log('apply', id);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query(`insert into schema_migrations (id) values ($1)`, [id]);
    await client.query('commit');
    console.log('ok  ', id);
  } catch (e) {
    await client.query('rollback');
    console.error('FAIL', id, e.message);
    process.exitCode = 1;
    break;
  }
}
await client.end();
