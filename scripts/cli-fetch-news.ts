import { loadEnv } from '../lib/load-env'
loadEnv()

import { fetchAllFeeds } from '../lib/rss'

async function main() {
  const lookbackHours = parseInt(process.env.LOOKBACK_HOURS ?? '24', 10)
  const articles = await fetchAllFeeds(lookbackHours)
  process.stdout.write(JSON.stringify({ articles, count: articles.length }, null, 2) + '\n')
}

main().catch((e: Error) => {
  process.stderr.write(JSON.stringify({ error: e.message }) + '\n')
  process.exit(1)
})
