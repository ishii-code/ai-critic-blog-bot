import { loadEnv } from '../lib/load-env'
loadEnv()

import { initSchema, closeDb } from '../lib/blog-db'

// Cloud SQL (PostgreSQL) に blog_articles テーブルを作成する。
// CREATE TABLE IF NOT EXISTS のため何度実行しても安全（冪等）。
async function main(): Promise<void> {
  await initSchema()
  process.stdout.write('migration done: blog_articles ready\n')
}

main()
  .catch((e: Error) => {
    process.stderr.write(`migration failed: ${e.message}\n`)
    process.exitCode = 1
  })
  .finally(() => closeDb())
