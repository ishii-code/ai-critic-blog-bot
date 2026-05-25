import { loadEnv } from '../lib/load-env'
loadEnv()
import { fetchAndParseUrl } from '../lib/rss'
import { generateArticle } from '../skills/generate-article/handlers'
import { insertArticle } from '../lib/blog-db'

async function main() {
  const newsUrl = process.argv[2]
  if (!newsUrl) {
    console.error('使い方: npm run test:article -- <ニュースURL>')
    process.exit(1)
  }

  console.log(`記事取得中: ${newsUrl}`)
  const sourceArticle = await fetchAndParseUrl(newsUrl)
  console.log(`タイトル: ${sourceArticle.title}`)
  console.log(`本文（先頭200字）: ${sourceArticle.body.slice(0, 200)}...\n`)

  console.log('記事生成中 (Claude Sonnet 4.6)...')
  const article = await generateArticle({
    source_article: sourceArticle,
    past_structure_types: [],
    similar_past_topics: [],
  })

  console.log('\n=== 生成された記事 ===')
  console.log(JSON.stringify(article, null, 2))

  if (process.env.RUN_MODE !== 'dry_run') {
    console.log('\nドラフトとしてブログDBに保存中...')
    const result = insertArticle({
      title: article.title,
      content: article.body,
      published: false,
    })
    console.log(`保存完了: Article ID = ${result.id}`)
    console.log(
      `ブログで確認: ${process.env.BLOG_PUBLIC_URL ?? 'http://localhost:3000'}/articles/${result.id}`,
    )
  } else {
    console.log('\n[dry_run mode: DBへの書き込みはスキップ]')
  }
}

main().catch(console.error)
