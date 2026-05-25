import Parser from 'rss-parser'
import path from 'path'
import fs from 'fs'
import { normalizeUrl } from './dedup'

interface SourceConfig {
  name: string
  tier: number
  category: string
  language: string
  url: string
  enabled: boolean
  verify_url?: boolean
  keyword_filter?: string
  notes?: string
}

interface RssSourcesConfig {
  sources: SourceConfig[]
  keyword_filters: {
    ai_required: string[]
    exclude: string[]
  }
  thresholds: {
    relevance_score_min: number
    max_articles_per_day: number
    lookback_hours: number
    fetch_timeout_seconds: number
  }
  url_normalization: {
    remove_query_params: string[]
  }
}

export interface Article {
  url: string
  title: string
  summary: string
  source_name: string
  source_tier: number
  published_at: Date
}

const CONFIG_PATH = path.resolve(__dirname, '../config/rss_sources.json')

function loadConfig(): RssSourcesConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as RssSourcesConfig
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

function matchesExclude(text: string, excludeList: string[]): boolean {
  return excludeList.some((kw) => text.includes(kw))
}

export async function fetchAllFeeds(lookbackHours = 24): Promise<Article[]> {
  const config = loadConfig()
  const parser = new Parser({
    timeout: config.thresholds.fetch_timeout_seconds * 1000,
    headers: { 'User-Agent': 'AI-Critic-Bot/1.0' },
  })
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000)

  const enabledSources = config.sources.filter((s) => s.enabled)

  const results = await Promise.allSettled(
    enabledSources.map(async (source) => {
      const feed = await parser.parseURL(source.url)
      const articles: Article[] = []

      for (const item of feed.items) {
        const link = item.link
        const title = item.title ?? ''
        const snippet = item.contentSnippet ?? item.content ?? ''

        if (!link || !title) continue

        const pubDate = item.isoDate
          ? new Date(item.isoDate)
          : item.pubDate
            ? new Date(item.pubDate)
            : null

        if (pubDate && pubDate < since) continue

        if (matchesExclude(title + ' ' + snippet, config.keyword_filters.exclude))
          continue

        if (source.keyword_filter === 'ai_required') {
          if (!matchesKeywords(title + ' ' + snippet, config.keyword_filters.ai_required))
            continue
        }

        articles.push({
          url: normalizeUrl(link, config.url_normalization.remove_query_params),
          title,
          summary: snippet.slice(0, 500),
          source_name: source.name,
          source_tier: source.tier,
          published_at: pubDate ?? new Date(),
        })
      }

      return articles
    }),
  )

  const allArticles: Article[] = []
  const seenUrls = new Set<string>()
  let successCount = 0

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const sourceName = enabledSources[i].name

    if (result.status === 'fulfilled') {
      successCount++
      for (const article of result.value) {
        if (!seenUrls.has(article.url)) {
          seenUrls.add(article.url)
          allArticles.push(article)
        }
      }
    } else {
      process.stderr.write(`Feed failed [${sourceName}]: ${String(result.reason)}\n`)
    }
  }

  process.stderr.write(
    `Fetched ${allArticles.length} articles from ${successCount}/${enabledSources.length} sources\n`,
  )

  return allArticles
    .sort((a, b) => b.published_at.getTime() - a.published_at.getTime())
    .slice(0, config.thresholds.max_articles_per_day)
}

export async function fetchAndParseUrl(
  url: string,
): Promise<{ url: string; title: string; body: string }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'AI-Critic-Bot/1.0' },
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)

  const html = await response.text()

  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/si)
  const rawTitle = titleMatch ? titleMatch[1] : ''
  const title = rawTitle.replace(/\s+/g, ' ').trim() || 'No title'

  const body = html
    .replace(/<script[^>]*>.*?<\/script>/gsi, '')
    .replace(/<style[^>]*>.*?<\/style>/gsi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000)

  return { url, title, body }
}
