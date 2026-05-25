import { loadEnv } from '../lib/load-env'
loadEnv()
import { fetchAllFeeds } from '../lib/rss'

async function main() {
  console.log('RSSフィード取得テスト開始...\n')

  const articles = await fetchAllFeeds(24)

  console.log('\n=== 取得結果 ===')
  console.log(`総記事数: ${articles.length}`)
  console.log('\n最新10件:')

  for (const a of articles.slice(0, 10)) {
    console.log(`[${a.source_name} / Tier${a.source_tier}] ${a.title}`)
    console.log(`  URL: ${a.url}`)
    console.log(`  公開: ${a.published_at.toISOString()}`)
    console.log()
  }
}

main().catch(console.error)
