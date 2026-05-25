import { loadEnv } from '../lib/load-env'
loadEnv()

import { fetchAllFeeds, fetchAndParseUrl } from '../lib/rss'
import { generateArticle, GeneratedArticle } from '../skills/generate-article/handlers'
import { insertArticle } from '../lib/blog-db'
import fs from 'fs'
import path from 'path'

const SOUL_PATH = path.resolve(__dirname, '../memory/SOUL.md')
const LOG_DIR = path.resolve(__dirname, '../logs')

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  process.stderr.write(line)
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.appendFileSync(path.join(LOG_DIR, 'daily.log'), line)
}

function readSoul(): { pastStructureTypes: number[]; pastTopics: string[] } {
  const content = fs.readFileSync(SOUL_PATH, 'utf-8')

  const structureTypes: number[] = []
  const topics: string[] = []

  const structureMatch = content.match(/## 構成タイプ使用履歴（直近10件）\n([\s\S]*?)(?=\n## |$)/)
  if (structureMatch) {
    const nums = structureMatch[1].match(/Type(\d+)/g)
    if (nums) structureTypes.push(...nums.map((s) => parseInt(s.replace('Type', ''), 10)))
  }

  const topicMatch = content.match(/## 過去7日のトピック（重複回避用）\n([\s\S]*?)(?=\n## |$)/)
  if (topicMatch) {
    const lines = topicMatch[1].split('\n').filter((l) => l.startsWith('- '))
    topics.push(...lines.map((l) => l.replace(/^- /, '').trim()))
  }

  return { pastStructureTypes: structureTypes, pastTopics: topics }
}

function updateSoul(article: GeneratedArticle, sourceTitle: string): void {
  const today = new Date().toISOString().slice(0, 10)
  const appendBlock = `
## 運用ログ ${today}
- タイトル: ${article.title}
- 元ネタ: ${sourceTitle}
- 構成タイプ: Type${article.structure_type}
- トピックタグ: ${article.topic_tags.join(', ')}
- 名指し企業: ${article.named_entities.join(', ') || 'なし'}
`
  fs.appendFileSync(SOUL_PATH, appendBlock)

  // 過去7日トピックを更新（初期化済みテキストを最初のエントリに置換）
  let content = fs.readFileSync(SOUL_PATH, 'utf-8')
  const newTopicLine = `- ${article.topic_tags[0] ?? article.title} (${today})`
  content = content.replace(
    '## 過去7日のトピック（重複回避用）\n(初期化済み)',
    `## 過去7日のトピック（重複回避用）\n${newTopicLine}`,
  )
  fs.writeFileSync(SOUL_PATH, content)
}

async function main(): Promise<void> {
  log('=== Daily blog run START ===')

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

  // Step 2: 最良記事を選定（Tier昇順 → 新着順）
  const best = [...articles].sort(
    (a, b) =>
      a.source_tier - b.source_tier ||
      b.published_at.getTime() - a.published_at.getTime(),
  )[0]
  log(`Selected: [Tier${best.source_tier} ${best.source_name}] ${best.title}`)

  // Step 3: 本文取得
  log(`Fetching full content: ${best.url}`)
  let sourceArticle
  try {
    sourceArticle = await fetchAndParseUrl(best.url)
  } catch (e) {
    log(`Content fetch failed: ${String(e)}`)
    process.exit(1)
  }

  // Step 4: SOUL.md から過去コンテキスト読み込み
  const soul = readSoul()
  log(`Past structure types: [${soul.pastStructureTypes.join(',')}]`)
  log(`Past topics: ${soul.pastTopics.length} topics`)

  // Step 5: 記事生成（3回リトライは handlers.ts 内で処理済み）
  log('Generating article via Claude Sonnet 4...')
  let generated: GeneratedArticle
  try {
    generated = await generateArticle({
      source_article: sourceArticle,
      past_structure_types: soul.pastStructureTypes,
      similar_past_topics: soul.pastTopics,
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

  // Step 7: ブログDB に保存（draft）
  const result = insertArticle({
    title: generated.title,
    content: generated.body,
    published: false,
  })
  const blogUrl = process.env.BLOG_PUBLIC_URL ?? 'http://localhost:3000'
  log(`Saved: Article ID=${result.id} → ${blogUrl}/articles/${result.id}`)

  // Step 8: SOUL.md 更新
  updateSoul(generated, best.title)
  log('SOUL.md updated')

  log('=== Daily blog run COMPLETE ===')
  process.stdout.write(
    JSON.stringify({
      id: result.id,
      url: `${blogUrl}/articles/${result.id}`,
      title: generated.title,
    }) + '\n',
  )
}

main().catch((e: Error) => {
  log(`FATAL: ${e.message}\n${e.stack ?? ''}`)
  process.exit(1)
})
