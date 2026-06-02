import { loadEnv } from '../lib/load-env'
loadEnv()

import { fetchAllFeeds, fetchAndParseUrl } from '../lib/rss'
import { generateArticle, GeneratedArticle } from '../skills/generate-article/handlers'
import {
  initSchema,
  insertArticle,
  getPastStructureTypes,
  getPastTopics,
  closeDb,
} from '../lib/blog-db'
import fs from 'fs'
import path from 'path'

const LOG_DIR = path.resolve(__dirname, '../logs')

// RUN_MODE:
//   dry_run        … 記事生成まで行うが DB へは書き込まない
//   publish        … published=true で公開保存
//   draft（既定）  … published=false で下書き保存
const RUN_MODE = process.env.RUN_MODE ?? 'draft'

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  // Cloud Run のログは stderr を拾う。ファイルログはローカル実行時のみ best-effort。
  process.stderr.write(line)
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'daily.log'), line)
  } catch {
    // コンテナの読み取り専用 FS 等では握りつぶす
  }
}

async function main(): Promise<void> {
  log(`=== Daily blog run START (RUN_MODE=${RUN_MODE}) ===`)

  // Step 0: スキーマ初期化（冪等）。初回実行がそのままマイグレーションになる。
  if (RUN_MODE !== 'dry_run') {
    await initSchema()
    log('Schema ready (blog_articles)')
  }

  // Step 1: RSS フィード取得
  log('Step 1: Fetching RSS feeds...')
  let articles
  try {
    articles = await fetchAllFeeds(24)
  } catch (e) {
    log(`RSS fetch failed: ${String(e)}`)
    process.exit(1)
  }

  if (articles.length === 0) {
    log('No articles found. Exiting.')
    process.exit(0)
  }
  log(`Found ${articles.length} articles`)

  // Step 2: 候補を優先順位付け（Tier昇順 → 新着順）
  const candidates = [...articles].sort(
    (a, b) =>
      a.source_tier - b.source_tier ||
      b.published_at.getTime() - a.published_at.getTime(),
  )

  // Step 3: 本文取得（先頭から順に試し、取得できた最初の記事を採用）。
  // データセンターIPからは一部メディア(openai.com等)が403を返すため、
  // 1記事の失敗で全体を落とさず次候補にフォールバックする。
  let best: (typeof candidates)[number] | undefined
  let sourceArticle: Awaited<ReturnType<typeof fetchAndParseUrl>> | undefined
  const MAX_TRIES = 8
  for (const cand of candidates.slice(0, MAX_TRIES)) {
    log(`Trying: [Tier${cand.source_tier} ${cand.source_name}] ${cand.title}`)
    try {
      sourceArticle = await fetchAndParseUrl(cand.url)
      best = cand
      break
    } catch (e) {
      log(`  skip (fetch failed): ${String(e)}`)
    }
  }

  if (!best || !sourceArticle) {
    log(`Content fetch failed for all ${Math.min(candidates.length, MAX_TRIES)} candidates. Exiting.`)
    process.exit(1)
  }
  log(`Selected: [Tier${best.source_tier} ${best.source_name}] ${best.title}`)

  // Step 4: 過去コンテキスト読み込み（DB から導出。SOUL.md の代替）
  let pastStructureTypes: number[] = []
  let pastTopics: string[] = []
  if (RUN_MODE !== 'dry_run') {
    pastStructureTypes = await getPastStructureTypes(10)
    pastTopics = await getPastTopics(7)
  }
  log(`Past structure types: [${pastStructureTypes.join(',')}]`)
  log(`Past topics: ${pastTopics.length} topics`)

  // Step 5: 記事生成（3回リトライは handlers.ts 内で処理済み）
  log('Generating article via Claude Sonnet 4...')
  let generated: GeneratedArticle
  try {
    generated = await generateArticle({
      source_article: sourceArticle,
      past_structure_types: pastStructureTypes,
      similar_past_topics: pastTopics,
    })
  } catch (e) {
    log(`Article generation failed: ${String(e)}`)
    process.exit(1)
  }
  log(`Generated: "${generated.title}" (Type${generated.structure_type})`)

  // Step 6: 安全チェック（フェーズ2でSlack承認に拡張予定）
  const sc = generated.sensitivity_self_check
  if (sc.criticizes_real_entity) {
    log(`Safety: criticizes real entity | concerns: ${sc.potential_concerns}`)
  }

  // Step 7: ブログDB に保存
  if (RUN_MODE === 'dry_run') {
    log('[dry_run] DB write skipped')
    process.stdout.write(
      JSON.stringify({ dry_run: true, title: generated.title }) + '\n',
    )
    log('=== Daily blog run COMPLETE (dry_run) ===')
    return
  }

  const published = RUN_MODE === 'publish'
  const result = await insertArticle({
    title: generated.title,
    content: generated.body,
    published,
    structureType: generated.structure_type,
    topicTags: generated.topic_tags,
    namedEntities: generated.named_entities,
    sourceTitle: best.title,
    sourceUrl: best.url,
  })
  const blogUrl = process.env.BLOG_PUBLIC_URL ?? 'http://localhost:3000'
  log(
    `Saved: Article ID=${result.id} (published=${published}) → ${blogUrl}/articles/${result.id}`,
  )

  log('=== Daily blog run COMPLETE ===')
  process.stdout.write(
    JSON.stringify({
      id: result.id,
      url: `${blogUrl}/articles/${result.id}`,
      title: generated.title,
      published,
    }) + '\n',
  )
}

main()
  .then(() => {
    process.exitCode = 0
  })
  .catch((e: Error) => {
    log(`FATAL: ${e.message}\n${e.stack ?? ''}`)
    process.exitCode = 1
  })
  .finally(async () => {
    // バッチJobなので明示終了する。pg プールや undici(keep-alive) の
    // オープンハンドルが残るとプロセスが終了せず task-timeout まで張り付くため。
    await closeDb()
    process.exit(process.exitCode ?? 0)
  })
