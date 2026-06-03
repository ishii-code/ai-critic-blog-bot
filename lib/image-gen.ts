import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { Storage } from '@google-cloud/storage'

// 記事内容ベースのカバー画像自動生成。
//   1. Claude API で記事 → gpt-image-1 用の英語プロンプトを生成
//   2. OpenAI gpt-image-1 で横長画像を生成（1536x1024 / 3:2）
//   3. Google Cloud Storage にアップロードし公開 URL を返す
//
// 必要な環境変数:
//   ANTHROPIC_API_KEY … プロンプト生成（Claude）
//   OPENAI_API_KEY    … 画像生成（gpt-image-1）
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
 * 記事の title / content / topic_tags から gpt-image-1 用の英語プロンプトを生成する。
 */
export async function generateCoverPrompt(source: CoverSource): Promise<string> {
  const client = new Anthropic()
  const excerpt = source.content.slice(0, 500)
  const instruction = `以下のブログ記事のカバー画像を生成するための、英語の画像生成プロンプト（gpt-image-1用）を作成してください。

【最重要】記事の中心的な主題・出来事を、見ただけで「何の話か」が伝わる具体的なシーン／被写体として描写すること。抽象的なグラデーションや幾何学模様だけで済ませてはいけない。記事のキーとなる対象（製品・技術・現象・状況）を象徴する具体物・場面・行為を主役に据える。

スタイル要件:
- modern editorial illustration（一流テックメディアのトップ記事カバー調）。クリーンで洗練され、ダーク寄りのモダンなトーンで統一する。
- 構図は横長 3:2。主題が一目で分かる明快なフォーカルポイントを持たせる。
- 実在企業のロゴ・商標・実在人物の顔は描かない。主題は一般化したモチーフ（無印の機器、象徴的なシルエット、抽象化したアイコン的表現など）で伝える。
- 画像内に文字・ロゴ・単語・数字を一切入れない。

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
