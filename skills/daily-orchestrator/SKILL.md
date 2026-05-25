---
name: daily-orchestrator
description: "AI批評家ブログの1日1記事自動投稿パイプラインを実行する。fetch-news→score-relevance→generate-article→safety-check→publish-blogの全工程を担当。"
metadata:
  openclaw:
    emoji: "🤖"
    requires:
      bins: ["npx"]
      env: ["ANTHROPIC_API_KEY"]
---

# Daily Orchestrator — AI批評家ブログ自動投稿

毎朝9時に起動し、今日の批評記事を1本生成してブログに投稿する。

## 実行環境

- BOT_DIR: `~/workspace/ai-critic-blog-bot`
- 実行コマンドは必ず `cd ~/workspace/ai-critic-blog-bot &&` を先頭に付ける

## Step 1: ニュース取得

```bash
cd ~/workspace/ai-critic-blog-bot && npx tsx scripts/cli-fetch-news.ts 2>/dev/null
```

JSON出力: `{ articles: [...], count: N }`
各記事: `{ url, title, summary, source_name, source_tier, published_at }`

## Step 2: 記事選定（スコアリング）

`score-relevance` スキルの基準で、取得した記事の中から最も批評価値が高い1件を選ぶ。
`memory/SOUL.md` を読み込み、過去24時間のトピックと重複しないよう注意する。

```bash
cat ~/workspace/ai-critic-blog-bot/memory/SOUL.md
```

## Step 3: 記事生成

`generate-article` スキルの人格・構成テンプレートに従い、選んだ記事の批評を書く。
出力形式: `{ title, body, structure_type, key_claims, topic_tags, named_entities, sensitivity_self_check }`

## Step 4: 安全チェック

`safety-check` スキルの基準で確認。
- `auto_publish` → Step 5へ進む
- `needs_approval` → Slackに通知してこの日の投稿を保留（今後実装）
- `block` → 投稿スキップ、理由をログに残す

## Step 5: ブログ投稿

生成した記事をJSONにして渡す:

```bash
cd ~/workspace/ai-critic-blog-bot && echo '<article_json>' | npx tsx scripts/cli-publish-blog.ts
```

JSON出力: `{ id: N, url: "..." }`

## Step 6: SOUL.md 更新

`memory/SOUL.md` に以下を追記:
- 今日の日付と取り上げたトピック
- 使用した構成タイプ番号
- 名指しした実在企業

## 失敗時の挙動

- ニュース取得失敗（全ソース失敗）: ログに記録して終了
- 記事生成失敗: 3回リトライ後スキップ
- ブログ投稿失敗: 重大エラーとして記録
- SNS投稿失敗: ブログ投稿は維持（Phase 3実装後）
