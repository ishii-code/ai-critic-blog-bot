import { Pool } from 'pg'

// Cloud SQL (PostgreSQL) への接続。
// DATABASE_URL は Secret Manager から注入される（Cloud SQL unix socket 形式）。
//   例: postgresql://postgres:****@/spm_dev_agent?host=/cloudsql/<INSTANCE_CONNECTION_NAME>
// ローカル検証時は cloud-sql-proxy 経由の 127.0.0.1:5432 を指す URL を渡す。

let _pool: Pool | null = null

function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL が設定されていません')
    }
    // 接続形式に応じて SSL を自動切り替え。
    // - unix socket（Cloud Run + Cloud SQL）/ localhost: 暗号化済み or 平文 → SSL 無効
    // - パブリック IP 直結（ローカル検証）: Cloud SQL は TLS 必須 → SSL 有効
    // host が URL エンコード（host=%2Fcloudsql%2F...）されるケースにも対応。
    const haystack = connectionString.toLowerCase()
    let decoded = haystack
    try {
      decoded = decodeURIComponent(haystack)
    } catch {
      // 不正な % が含まれる場合はデコード前で判定
    }
    const isSocket =
      decoded.includes('/cloudsql/') || decoded.includes('host=/')
    const isLocalhost =
      decoded.includes('localhost') || decoded.includes('127.0.0.1')
    const useSsl = !isSocket && !isLocalhost
    _pool = new Pool({
      connectionString,
      max: 2,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    })
  }
  return _pool
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

/**
 * blog_articles テーブルを冪等に作成する（CREATE TABLE IF NOT EXISTS）。
 * Cloud Run Job 起動時に毎回呼ばれ、初回実行がそのままマイグレーションになる。
 */
export async function initSchema(): Promise<void> {
  const pool = getPool()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_articles (
      id             SERIAL PRIMARY KEY,
      title          TEXT NOT NULL,
      content        TEXT NOT NULL,
      published      BOOLEAN NOT NULL DEFAULT FALSE,
      structure_type INTEGER,
      topic_tags     JSONB NOT NULL DEFAULT '[]'::jsonb,
      named_entities JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_title   TEXT,
      source_url     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_blog_articles_created_at ON blog_articles (created_at DESC)`,
  )
  // カバー画像カラム（DALL-E 3 自動生成）。既存テーブルにも冪等に追加する。
  await pool.query(`
    ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS cover_image_url TEXT;
    ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS cover_image_prompt TEXT;
    ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS cover_image_generated_at TIMESTAMP;
  `)
}

export interface InsertArticleInput {
  title: string
  content: string
  published?: boolean
  structureType?: number
  topicTags?: string[]
  namedEntities?: string[]
  sourceTitle?: string
  sourceUrl?: string
}

export interface InsertArticleResult {
  id: number
}

export async function insertArticle(
  article: InsertArticleInput,
): Promise<InsertArticleResult> {
  const pool = getPool()
  const res = await pool.query<{ id: number }>(
    `INSERT INTO blog_articles
       (title, content, published, structure_type, topic_tags, named_entities, source_title, source_url)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      article.title,
      article.content,
      article.published ?? false,
      article.structureType ?? null,
      JSON.stringify(article.topicTags ?? []),
      JSON.stringify(article.namedEntities ?? []),
      article.sourceTitle ?? null,
      article.sourceUrl ?? null,
    ],
  )
  return { id: res.rows[0].id }
}

/**
 * 直近の構成タイプ履歴を取得（重複回避用）。SOUL.md の代替。
 */
export async function getPastStructureTypes(limit = 10): Promise<number[]> {
  const pool = getPool()
  const res = await pool.query<{ structure_type: number }>(
    `SELECT structure_type FROM blog_articles
     WHERE structure_type IS NOT NULL
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
  )
  return res.rows.map((r) => r.structure_type)
}

/**
 * 直近 days 日のトピックタグを取得（重複回避用）。SOUL.md の代替。
 */
export async function getPastTopics(days = 7): Promise<string[]> {
  const pool = getPool()
  const res = await pool.query<{ topic_tags: string[] }>(
    `SELECT topic_tags FROM blog_articles
     WHERE created_at > now() - make_interval(days => $1::int)`,
    [days],
  )
  const topics: string[] = []
  for (const row of res.rows) {
    if (Array.isArray(row.topic_tags)) topics.push(...row.topic_tags)
  }
  return Array.from(new Set(topics))
}

// ===== カバー画像（DALL-E 3 自動生成）=====

/** カバー画像生成に必要な記事フィールド。 */
export interface ArticleForCover {
  id: number
  title: string
  content: string
  topicTags: string[]
}

interface ArticleForCoverRow {
  id: number
  title: string
  content: string
  topic_tags: unknown
}

function rowToArticleForCover(row: ArticleForCoverRow): ArticleForCover {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    topicTags: Array.isArray(row.topic_tags)
      ? row.topic_tags.filter((t): t is string => typeof t === 'string')
      : [],
  }
}

/** ID 指定で 1 記事を取得（カバー生成用）。存在しなければ null。 */
export async function getArticleForCover(
  id: number,
): Promise<ArticleForCover | null> {
  const pool = getPool()
  const res = await pool.query<ArticleForCoverRow>(
    `SELECT id, title, content, topic_tags FROM blog_articles WHERE id = $1`,
    [id],
  )
  if (res.rows.length === 0) return null
  return rowToArticleForCover(res.rows[0])
}

/** cover_image_url が未設定の記事を取得（古い順）。 */
export async function listArticlesMissingCover(
  limit = 100,
): Promise<ArticleForCover[]> {
  const pool = getPool()
  const res = await pool.query<ArticleForCoverRow>(
    `SELECT id, title, content, topic_tags FROM blog_articles
     WHERE cover_image_url IS NULL
     ORDER BY id ASC
     LIMIT $1`,
    [limit],
  )
  return res.rows.map(rowToArticleForCover)
}

/** 生成済みカバー画像の URL とプロンプトを記事に保存する。 */
export async function updateCoverImage(
  id: number,
  coverImageUrl: string,
  coverImagePrompt: string,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE blog_articles
       SET cover_image_url = $2,
           cover_image_prompt = $3,
           cover_image_generated_at = now(),
           updated_at = now()
     WHERE id = $1`,
    [id, coverImageUrl, coverImagePrompt],
  )
}
