import { loadEnv } from '../lib/load-env'
loadEnv()

import { initSchema, insertArticle, closeDb } from '../lib/blog-db'

interface ArticleInput {
  title: string
  body?: string
  content?: string
  published?: boolean
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
  })
}

async function main() {
  const raw = process.argv[2] ?? (await readStdin())
  const input = JSON.parse(raw) as ArticleInput

  await initSchema()
  const result = await insertArticle({
    title: input.title,
    content: input.content ?? input.body ?? '',
    published: process.env.INITIAL_POST_STATUS === 'published' ? (input.published ?? false) : false,
  })

  const blogUrl = process.env.BLOG_PUBLIC_URL ?? 'http://localhost:3000'
  const url = `${blogUrl}/articles/${result.id}`

  process.stdout.write(JSON.stringify({ id: result.id, url }) + '\n')
}

main()
  .catch((e: Error) => {
    process.stderr.write(JSON.stringify({ error: e.message }) + '\n')
    process.exitCode = 1
  })
  .finally(() => closeDb())
