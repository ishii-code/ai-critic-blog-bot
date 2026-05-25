import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'

const SYSTEM_PROMPT = fs.readFileSync(
  path.resolve(__dirname, 'critic_prompt.md'),
  'utf-8',
)

export interface SourceArticle {
  url: string
  title: string
  body: string
}

export interface SensitivityCheck {
  criticizes_real_entity: boolean
  factual_basis: string
  potential_concerns: string
}

export interface GeneratedArticle {
  title: string
  body: string
  structure_type: number
  key_claims: string[]
  topic_tags: string[]
  named_entities: string[]
  sensitivity_self_check: SensitivityCheck
}

export async function generateArticle(input: {
  source_article: SourceArticle
  past_structure_types: number[]
  similar_past_topics: string[]
}): Promise<GeneratedArticle> {
  const userMessage = `以下のニュースを取り上げて批評記事を書いてください。

## ニュース本文
タイトル: ${input.source_article.title}
URL: ${input.source_article.url}
本文:
${input.source_article.body}

## 制約
- 過去24時間で使った構成タイプ: ${input.past_structure_types.join(', ') || 'なし'}（これらは避ける）
- 過去7日扱ったトピック: ${input.similar_past_topics.join(', ') || 'なし'}（類似テーマは避ける）`

  const client = new Anthropic()

  for (let attempt = 1; attempt <= 3; attempt++) {
    const extraInstruction =
      attempt > 1
        ? '\n\n重要: JSONのみ返してください。マークダウンのコードフェンス（```json等）や解説文は絶対に禁止。最初の文字が{で始まり、最後の文字が}で終わる純粋なJSONのみ。'
        : ''

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: SYSTEM_PROMPT + extraInstruction,
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    try {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim()
      const parsed = JSON.parse(cleaned) as GeneratedArticle
      return parsed
    } catch {
      if (attempt === 3) {
        throw new Error(`JSON parse failed after 3 attempts. Last response:\n${text}`)
      }
      process.stderr.write(`Attempt ${attempt}: JSON parse failed, retrying...\n`)
    }
  }

  throw new Error('unreachable')
}
