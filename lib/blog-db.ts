import Database from 'better-sqlite3'
import path from 'path'
import os from 'os'

const BLOG_DB_PATH =
  process.env.BLOG_DB_PATH || path.resolve(os.homedir(), 'to-do-4/dev.db')

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(BLOG_DB_PATH)
  }
  return _db
}

export interface InsertArticleInput {
  title: string
  content: string
  published?: boolean
}

export interface InsertArticleResult {
  id: number
}

export function insertArticle(article: InsertArticleInput): InsertArticleResult {
  const db = getDb()
  const now = new Date().toISOString()
  const published = article.published ?? false

  const stmt = db.prepare(`
    INSERT INTO Article (title, content, published, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `)

  const result = stmt.run(
    article.title,
    article.content,
    published ? 1 : 0,
    now,
    now,
  )

  return { id: Number(result.lastInsertRowid) }
}
