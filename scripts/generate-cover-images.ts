import { loadEnv } from '../lib/load-env'
loadEnv()

import {
  initSchema,
  getArticleForCover,
  listArticlesMissingCover,
  updateCoverImage,
  closeDb,
  type ArticleForCover,
} from '../lib/blog-db'
import { generateAndStoreCover } from '../lib/image-gen'

// カバー画像一括/個別生成スクリプト。
//   npm run generate-cover-images -- --all-missing      … cover_image_url IS NULL の全記事
//   npm run generate-cover-images -- --article-id=3     … 指定 ID のみ（リトライ用）
//
// 画像生成に失敗しても記事自体は published のまま継続する。
// cover_image_url=NULL のまま残し、[IMAGE_GEN] に失敗理由を出力する。

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`)
}

interface CliArgs {
  allMissing: boolean
  articleId?: number
}

function parseArgs(argv: string[]): CliArgs {
  let allMissing = false
  let articleId: number | undefined
  for (const arg of argv) {
    if (arg === '--all-missing') {
      allMissing = true
    } else if (arg.startsWith('--article-id=')) {
      const raw = arg.slice('--article-id='.length)
      const n = Number.parseInt(raw, 10)
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--article-id は正の整数で指定してください: "${raw}"`)
      }
      articleId = n
    }
  }
  return { allMissing, articleId }
}

/** 1 記事のカバー画像を生成・保存する。成功なら true。 */
async function processArticle(article: ArticleForCover): Promise<boolean> {
  log(`[IMAGE_GEN] start article=${article.id} "${article.title.slice(0, 40)}"`)
  try {
    const cover = await generateAndStoreCover(article.id, {
      title: article.title,
      content: article.content,
      topicTags: article.topicTags,
    })
    await updateCoverImage(article.id, cover.url, cover.prompt)
    log(`[IMAGE_GEN] success article=${article.id} url=${cover.url}`)
    return true
  } catch (e) {
    // rate limit / content policy 等で失敗しても記事公開は継続する。
    const reason = e instanceof Error ? e.message : String(e)
    log(`[IMAGE_GEN] FAILED article=${article.id} reason=${reason}`)
    return false
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.allMissing && args.articleId === undefined) {
    log(
      'Usage: generate-cover-images -- (--all-missing | --article-id=N)',
    )
    process.exitCode = 2
    return
  }

  await initSchema()

  let targets: ArticleForCover[] = []
  if (args.articleId !== undefined) {
    const article = await getArticleForCover(args.articleId)
    if (!article) {
      log(`[IMAGE_GEN] article id=${args.articleId} が見つかりません`)
      process.exitCode = 1
      return
    }
    targets = [article]
  } else {
    targets = await listArticlesMissingCover(100)
  }

  log(`対象記事: ${targets.length} 件`)
  let ok = 0
  let ng = 0
  for (const article of targets) {
    const success = await processArticle(article)
    if (success) ok++
    else ng++
  }

  log(`完了: 成功 ${ok} 件 / 失敗 ${ng} 件`)
  process.stdout.write(JSON.stringify({ total: targets.length, ok, ng }) + '\n')
  // 一括生成では一部失敗しても exit 0（記事公開は継続というポリシー）。
  // 個別 ID 指定で失敗した場合のみ非ゼロにして CI/リトライで検知できるようにする。
  if (args.articleId !== undefined && ng > 0) {
    process.exitCode = 1
  }
}

main()
  .catch((e: Error) => {
    log(`FATAL: ${e.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
    process.exit(process.exitCode ?? 0)
  })
