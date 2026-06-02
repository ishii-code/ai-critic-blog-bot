# ai-critic-blog-bot

AI業界ニュースを RSS で収集し、Claude（Sonnet 4.6）で批評記事を生成して
ブログDB（PostgreSQL）に保存する日次自動投稿パイプライン。
**Cloud Run Jobs** 上で動作し、**Cloud Scheduler** が毎朝9時（JST）に発火する。

## アーキテクチャ

```
Cloud Scheduler (cron: 0 9 * * * / Asia/Tokyo)
   │ HTTP POST (OAuth, run.invoker)
   ▼
Cloud Run Job  ai-critic-blog-bot   ── npx tsx scripts/run-daily.ts
   │  1. RSS収集 (config/rss_sources.json の有効ソース)
   │  2. Tier昇順→新着順で候補を並べ、本文取得できた最初の記事を採用
   │     （DC IPからは一部メディアが403/404のためフォールバック必須）
   │  3. 過去の構成タイプ/トピックを blog_articles から導出（重複回避）
   │  4. Claude で批評記事を生成（JSON, 3回リトライ）
   │  5. blog_articles に保存
   ▼
Cloud SQL (PostgreSQL)  spm-dev-agent-postgres / DB: spm_dev_agent
   └─ table: blog_articles
```

状態（構成タイプ履歴・トピック履歴）は **PostgreSQL の `blog_articles` から導出**する。
旧実装のローカル `memory/SOUL.md` ファイルには依存しない（Cloud Run の FS は揮発性のため）。

## 環境変数

| 変数 | 必須 | 説明 | 注入元 |
|------|------|------|--------|
| `DATABASE_URL` | ✅ | Cloud SQL 接続文字列（unix socket 形式） | Secret Manager `spm-dev-agent-database-url` |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic APIキー | Secret Manager `spm-dev-agent-anthropic-key` |
| `RUN_MODE` | – | `publish`=公開保存 / `draft`=下書き保存 / `dry_run`=DB書込なし（既定 `draft`） | `--set-env-vars` |
| `BLOG_PUBLIC_URL` | – | 生成URLのベース（ログ表示用、既定 `http://localhost:3000`） | env |

`DATABASE_URL` の形式（Cloud SQL Auth ソケット）:
```
postgresql://postgres:****@/spm_dev_agent?host=/cloudsql/vets-biz-aigen-apps:asia-northeast1:spm-dev-agent-postgres
```
このソケットは Cloud Run に `--set-cloudsql-instances` を付けた時のみマウントされる。**必須**。

## GCP リソース

| 項目 | 値 |
|------|-----|
| Project | `vets-biz-aigen-apps` |
| Region | `asia-northeast1` |
| Artifact Registry | `asia-northeast1-docker.pkg.dev/vets-biz-aigen-apps/spm-dev-agent/ai-critic-blog-bot` |
| Cloud Run Job | `ai-critic-blog-bot` |
| Cloud Scheduler | `ai-critic-blog-bot-daily` |
| Cloud SQL | `vets-biz-aigen-apps:asia-northeast1:spm-dev-agent-postgres` / DB `spm_dev_agent` |
| 実行SA | `842623777962-compute@developer.gserviceaccount.com` |

実行SAに必要なロール: `roles/secretmanager.secretAccessor`（両シークレット）、
`roles/cloudsql.client`、`roles/run.invoker`（Scheduler発火用）。

## デプロイ手順

### 1. ビルド & push（linux/amd64 必須）
```bash
IMG="asia-northeast1-docker.pkg.dev/vets-biz-aigen-apps/spm-dev-agent/ai-critic-blog-bot:latest"
gcloud auth configure-docker asia-northeast1-docker.pkg.dev --quiet
docker buildx build --platform linux/amd64 -t "$IMG" --push .
```

### 2. Cloud Run Job 作成 / 更新
```bash
gcloud run jobs deploy ai-critic-blog-bot \
  --image="$IMG" \
  --region=asia-northeast1 \
  --project=vets-biz-aigen-apps \
  --set-secrets="DATABASE_URL=spm-dev-agent-database-url:latest,ANTHROPIC_API_KEY=spm-dev-agent-anthropic-key:latest" \
  --set-env-vars="RUN_MODE=publish" \
  --set-cloudsql-instances=vets-biz-aigen-apps:asia-northeast1:spm-dev-agent-postgres \
  --service-account=842623777962-compute@developer.gserviceaccount.com \
  --max-retries=1 --task-timeout=600 --memory=512Mi --cpu=1
```
> `:latest` を push し直した場合は再デプロイ（または `gcloud run jobs update ... --image=...`）で
> 新ダイジェストを反映する。Job はデプロイ時のダイジェストに固定される。

### 3. Cloud Scheduler 作成（毎朝9時 JST）
```bash
gcloud scheduler jobs create http ai-critic-blog-bot-daily \
  --schedule="0 9 * * *" \
  --time-zone="Asia/Tokyo" \
  --location=asia-northeast1 \
  --project=vets-biz-aigen-apps \
  --uri="https://asia-northeast1-run.googleapis.com/v2/projects/vets-biz-aigen-apps/locations/asia-northeast1/jobs/ai-critic-blog-bot:run" \
  --http-method=POST \
  --oauth-service-account-email=842623777962-compute@developer.gserviceaccount.com
```

### 4. 単発テスト実行
```bash
gcloud run jobs execute ai-critic-blog-bot --region=asia-northeast1 --project=vets-biz-aigen-apps --wait
```

## DB マイグレーション

`blog_articles` は `initSchema()`（`CREATE TABLE IF NOT EXISTS`）で冪等に作成され、
Job 起動時に毎回実行される。**初回実行がそのままマイグレーション**になる。

ローカルから明示的に流す場合は cloud-sql-proxy 経由:
```bash
cloud-sql-proxy --port 5433 vets-biz-aigen-apps:asia-northeast1:spm-dev-agent-postgres &
PASS=$(gcloud secrets versions access latest --secret=spm-dev-agent-database-url \
       | sed -E 's#^postgresql://postgres:([^@]+)@.*#\1#')
DATABASE_URL="postgresql://postgres:${PASS}@127.0.0.1:5433/spm_dev_agent" npm run migrate
```

## 運用コマンド

### ログ確認
```bash
# 直近の実行ログ
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="ai-critic-blog-bot"' \
  --project=vets-biz-aigen-apps --limit=50 --order=asc --format='value(textPayload)'
```

### Scheduler 停止 / 再開
```bash
# 停止（pause）
gcloud scheduler jobs pause ai-critic-blog-bot-daily --location=asia-northeast1 --project=vets-biz-aigen-apps
# 再開（resume）
gcloud scheduler jobs resume ai-critic-blog-bot-daily --location=asia-northeast1 --project=vets-biz-aigen-apps
# 次回実行時刻など確認
gcloud scheduler jobs describe ai-critic-blog-bot-daily --location=asia-northeast1 --project=vets-biz-aigen-apps
# 手動でいま発火させる
gcloud scheduler jobs run ai-critic-blog-bot-daily --location=asia-northeast1 --project=vets-biz-aigen-apps
```

### 保存記事の確認（cloud-sql-proxy 経由）
```bash
PASS=$(gcloud secrets versions access latest --secret=spm-dev-agent-database-url \
       | sed -E 's#^postgresql://postgres:([^@]+)@.*#\1#')
PGPASSWORD="$PASS" psql -h 127.0.0.1 -p 5433 -U postgres -d spm_dev_agent \
  -c "SELECT id, published, structure_type, left(title,40) FROM blog_articles ORDER BY id DESC LIMIT 10;"
```

## トラブルシューティング

| 症状 | 原因 / 対処 |
|------|-------------|
| `DATABASE_URL が設定されていません` | `--set-secrets` 漏れ。シークレットへのSAアクセス権を確認 |
| DB接続が `ENOENT /cloudsql/...sock` | `--set-cloudsql-instances` 漏れ。ソケットがマウントされていない |
| `Content fetch failed for all candidates` | 全候補が403/404。DC IPブロックや一時障害。`MAX_TRIES` 拡大やソース見直し |
| 一部フィードが404/403 | `openai.com`/`reddit` 等はDC IPを弾く。フォールバックで他ソースを採用するため致命的ではない |
| `JSON parse failed after 3 attempts` | Claudeがコードフェンス付きで返答。`handlers.ts` のリトライ指示を確認 |
| Job がデプロイ時の古い動作のまま | `:latest` 更新後に `gcloud run jobs update --image=...` で再固定 |

## ローカル開発

```bash
npm install
# .env を用意（.env.example 参照）。ローカルDBは cloud-sql-proxy 経由を推奨
npm run fetch-news        # RSS収集のみ
RUN_MODE=dry_run npm run run-daily   # 生成まで（DB書込なし）
npm run test:article -- <ニュースURL>  # 単一URLから記事生成
```

## ファイル構成

```
scripts/
  run-daily.ts          # 日次パイプライン本体（Cloud Run Jobs のエントリ）
  migrate.ts            # blog_articles 作成（冪等）
  cli-fetch-news.ts     # RSS収集CLI
  cli-publish-blog.ts   # JSON記事をDB保存するCLI
lib/
  rss.ts                # RSS取得・キーワードフィルタ・本文取得
  blog-db.ts            # PostgreSQL アクセス（pg）
  dedup.ts              # URL正規化
  load-env.ts           # .env ローダ（本番はSecret注入のため未使用）
skills/
  generate-article/     # Claude批評記事生成（critic_prompt.md + handlers.ts）
config/
  rss_sources.json      # RSSソース定義・キーワード・しきい値
Dockerfile              # Cloud Run Jobs 用イメージ
```
