import 'dotenv/config';
import path from 'path';
import { readdir, readFile } from 'fs/promises';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations');

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  return databaseUrl;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((row) => row.filename));
}

async function applyMigration(pool: Pool, filename: string): Promise<void> {
  const migrationPath = path.join(MIGRATIONS_DIR, filename);
  const sql = await readFile(migrationPath, 'utf8');

  if (!sql.trim()) {
    throw new Error(`Migration file is empty: ${filename}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`✅ Applied migration: ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: getDatabaseUrl() });

  try {
    await ensureMigrationsTable(pool);

    const files = await getMigrationFiles();
    if (files.length === 0) {
      console.log('No SQL migration files found.');
      return;
    }

    const applied = await getAppliedMigrations(pool);
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    console.log(`Running ${pending.length} migration(s)...`);
    for (const file of pending) {
      await applyMigration(pool, file);
    }
    console.log('🎉 Migration run complete.');
  } finally {
    await pool.end();
  }
}

runMigrations().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
