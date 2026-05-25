---
name: publish-blog
description: "安全チェック済みの記事を既存ブログ（~/to-do-4）のSQLiteデータベースにINSERTする。最初の2週間はdraft保存。"
metadata:
  openclaw:
    emoji: "📝"
    requires:
      bins: ["npx"]
---

# Publish Blog

承認済み記事を `~/to-do-4/dev.db` の `Article` テーブルに INSERT する。

## 実行

記事JSONをstdinまたは引数で渡す:

```bash
# stdin経由（推奨）
echo '<article_json>' | cd ~/workspace/ai-critic-blog-bot && npx tsx scripts/cli-publish-blog.ts

# 引数経由
cd ~/workspace/ai-critic-blog-bot && npx tsx scripts/cli-publish-blog.ts '<article_json>'
```

## 入力フォーマット

```json
{
  "title": "記事タイトル（30字以内）",
  "body": "記事本文（800-1500字）"
}
```

## 出力フォーマット

```json
{
  "id": 42,
  "url": "http://localhost:3000/articles/42"
}
```

## 運用設定

- `.env` の `INITIAL_POST_STATUS` が `published` でない限り `published: false`（下書き）で保存
- 最初の2週間は下書き保存 → ブログ管理画面でレビュー → 手動公開
- 安定後に `INITIAL_POST_STATUS=published` に変更して直接公開

## DBスキーマ（既存ブログ）

```sql
Article: id, title, content, published(BOOL), createdAt, updatedAt
```

パス: `~/to-do-4/dev.db`
