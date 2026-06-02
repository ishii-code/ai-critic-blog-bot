// ブログ公開成功時の Slack DM 通知（best-effort）。
//   - グローバル fetch を使用（依存追加なし、Node22）
//   - SLACK_BOT_TOKEN 未設定なら何もしない
//   - SLACK_MENTION_USER_ID 宛に conversations.open → chat.postMessage で DM
//   - 失敗しても絶対に throw しない（公開フローを止めない）

const DEFAULT_MENTION_USER_ID = 'U0AMRAQDW65'

export interface NotifyPublishedInput {
  title: string
  url: string
  coverImageUrl?: string | null
}

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`)
}

/** Slack API を叩く小さなヘルパー。ok=false や HTTP エラーは例外にする。 */
async function slackPost<T extends { ok: boolean; error?: string }>(
  method: string,
  token: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`${method} HTTP ${res.status}`)
  }
  const data = (await res.json()) as T
  if (!data.ok) {
    throw new Error(`${method} returned error: ${data.error ?? 'unknown'}`)
  }
  return data
}

/**
 * ブログ公開を Slack DM で通知する（メンション付き）。best-effort。
 */
export async function notifyPublished(
  input: NotifyPublishedInput,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) {
    log('[SLACK_NOTIFY] skip (SLACK_BOT_TOKEN 未設定)')
    return
  }

  const userId = process.env.SLACK_MENTION_USER_ID || DEFAULT_MENTION_USER_ID

  try {
    // DM チャンネルを取得（既存なら再利用される）。
    const opened = await slackPost<{
      ok: boolean
      error?: string
      channel?: { id?: string }
    }>('conversations.open', token, { users: userId })

    const channelId = opened.channel?.id
    if (!channelId) {
      throw new Error('conversations.open が channel.id を返しませんでした')
    }

    let text = `<@${userId}> ✅ ブログ公開: ${input.title}\n${input.url}`
    if (input.coverImageUrl) {
      text += `\n${input.coverImageUrl}`
    }

    await slackPost('chat.postMessage', token, {
      channel: channelId,
      text,
      // メンションを確実に通知へ反映させる。
      link_names: true,
    })

    log(`[SLACK_NOTIFY] sent DM to ${userId}`)
  } catch (e) {
    // 通知失敗は記事公開を止めない。secret 値はログに出さない。
    const reason = e instanceof Error ? e.message : String(e)
    log(`[SLACK_NOTIFY] error: ${reason}`)
  }
}
