import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Storage } from '@google-cloud/storage'

// 記事内容ベースのカバー画像自動生成。
//   1. Claude API で記事 → DALL-E 3 用の英語プロンプトを生成
//   2. OpenAI DALL-E 3 で 16:9 画像を生成（1792x1024 / standard）
//   3. Google Cloud Storage にアップロードし公開 URL を返す
//
// 必要な環境変数:
//   ANTHROPIC_API_KEY … プロンプト生成（Claude）
//   OPENAI_API_KEY    … 画像生成（DALL-E 3）
//   GCS_BUCKET_NAME   … アップロード先バケット

const PROMPT_MODEL = 'claude-sonnet-4-6'
// 画像生成モデル。当該 OpenAI キーは dall-e-3 非対応で gpt-image-1 系のみ利用可能なため
// gpt-image-1 を既定にする（env IMAGE_MODEL で上書き可）。
// gpt-image-1 のサイズは 1024x1024 / 1536x1024(横) / 1024x1536(縦) / auto。
// 16:9 に最も近い横長として 1536x1024（3:2）を採用し、表示側で 16:9 にクロップする。
const IMAGE_MODEL = process.env.IMAGE_MODEL ?? 'gpt-image-1'
const IMAGE_SIZE = '1536x1024'
const IMAGE_QUALITY = 'medium'

export interface CoverSource {
  title: string
  content: string
  topicTags: string[]
}

export interface GeneratedCover {
  /** GCS 上の公開 URL */
  url: string
  /** DALL-E 3 に渡した英語プロンプト */
  prompt: string
}

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY が設定されていません')
    }
    _openai = new OpenAI()
  }
  return _openai
}

let _storage: Storage | null = null
function getStorage(): Storage {
  if (!_storage) _storage = new Storage()
  return _storage
}

function getBucketName(): string {
  const name = process.env.GCS_BUCKET_NAME
  if (!name) throw new Error('GCS_BUCKET_NAME が設定されていません')
  return name
}

/**
 * 記事の title / content / topic_tags から DALL-E 3 用の英語プロンプトを生成する。
 */
export async function generateCoverPrompt(source: CoverSource): Promise<string> {
  const client = new Anthropic()
  const excerpt = source.content.slice(0, 500)
  const instruction = `以下のブログ記事のカバー画像を生成するための、英語のDALL-E 3用プロンプトを作成してください。
- 抽象的・概念的でテック記事に映える
- ダーク調・モダン・ミニマル
- 文字は入れない
- 16:9アスペクト比想定
- リテラルではなく比喩的表現
タイトル: ${source.title}
タグ: ${source.topicTags.join(', ')}
内容抜粋: ${excerpt}

英語プロンプトのみ出力してください、説明文不要。`

  const message = await client.messages.create({
    model: PROMPT_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: instruction }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()

  if (!text) {
    throw new Error('プロンプト生成結果が空です')
  }
  // 文字を入れない指示を補強（DALL-E は時々文字を描く）。
  return `${text}\n\nNo text, no letters, no words in the image.`
}

/**
 * DALL-E 3 で画像を生成し、バイナリ（PNG）を Buffer で返す。
 */
export async function generateImageBuffer(prompt: string): Promise<Buffer> {
  const openai = getOpenAI()
  const res = await openai.images.generate({
    model: IMAGE_MODEL,
    prompt,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
    n: 1,
  })

  const first = res.data?.[0]
  // gpt-image-1 は b64_json を返す。dall-e 系の url 返却にもフォールバック対応。
  if (first?.b64_json) {
    return Buffer.from(first.b64_json, 'base64')
  }
  const imageUrl = first?.url
  if (!imageUrl) {
    throw new Error('画像生成 API が画像データを返しませんでした')
  }
  const resp = await fetch(imageUrl)
  if (!resp.ok) {
    throw new Error(`画像ダウンロード失敗: HTTP ${resp.status}`)
  }
  const arrayBuf = await resp.arrayBuffer()
  return Buffer.from(arrayBuf)
}

/**
 * 画像バイナリを GCS にアップロードし、公開 URL を返す。
 * バケットは uniform bucket-level access + allUsers:objectViewer 前提（個別 ACL 不要）。
 */
export async function uploadCoverToGcs(
  articleId: number,
  buffer: Buffer,
): Promise<string> {
  const bucketName = getBucketName()
  const timestamp = Date.now()
  const objectName = `blog/${articleId}-${timestamp}.png`

  const file = getStorage().bucket(bucketName).file(objectName)
  await file.save(buffer, {
    contentType: 'image/png',
    resumable: false,
    metadata: {
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })

  return `https://storage.googleapis.com/${bucketName}/${objectName}`
}

/**
 * 記事 1 件分のカバー画像を生成 → アップロードまで通しで実行する。
 * 失敗時は例外を投げる（呼び出し側で握りつぶして記事公開は継続する想定）。
 */
export async function generateAndStoreCover(
  articleId: number,
  source: CoverSource,
): Promise<GeneratedCover> {
  const prompt = await generateCoverPrompt(source)
  const buffer = await generateImageBuffer(prompt)
  const url = await uploadCoverToGcs(articleId, buffer)
  return { url, prompt }
}
