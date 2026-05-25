---
name: fetch-news
description: "RSSフィードから過去24時間のAI関連ニュースを取得し、重複排除・キーワードフィルタ済みのJSON記事リストを返す。"
metadata:
  openclaw:
    emoji: "📡"
    requires:
      bins: ["npx"]
---

# Fetch News

RSS 25フィード（5層構成）から直近24時間のAIニュースを取得する。

## 実行

```bash
cd ~/workspace/ai-critic-blog-bot && npx tsx scripts/cli-fetch-news.ts 2>/dev/null
```

## 出力

```json
{
  "articles": [
    {
      "url": "https://...",
      "title": "記事タイトル",
      "summary": "本文の先頭500字",
      "source_name": "The Decoder",
      "source_tier": 3,
      "published_at": "2026-05-24T01:00:00.000Z"
    }
  ],
  "count": 12
}
```

## ソース層（tier）

- Tier 1: 公式（Anthropic, OpenAI, Google AI, Meta AI, DeepMind）
- Tier 2: 国内メディア（Ledge.ai, ITmedia AI+, Publickey, gihyo.jp, AIsmiley）
- Tier 3: 英語メディア（The Decoder, Marktechpost, Ars Technica, TechCrunch AI, MIT Tech Review）
- Tier 4: 批評系（Gary Marcus, AI Snake Oil, Ed Zitron, 404 Media, Import AI）
- Tier 5: コミュニティ（HN, Reddit）

## エラー処理

個別フィード失敗は無視して続行。全ソース失敗時のみ exit code 1。
stderr に `{ error: "..." }` JSON を出力。
