# ai-critic-blog-bot — Cloud Run Jobs 用イメージ
# Cloud Scheduler が毎朝発火し、このコンテナが run-daily を単発実行する（自前ループはしない）。
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    RUN_MODE=publish

# 依存だけ先に入れてレイヤキャッシュを効かせる。
# ネイティブモジュールは無い（pg/rss-parser/tsx は pure JS）ので build ツールは不要。
COPY package.json package-lock.json ./
RUN npm ci

# アプリ本体（config/*.json や skills/*.md も含めてコピー。tsx でソース直実行するため
# tsc ビルドは不要で、__dirname 相対の .md / .json 読み込みもそのまま動く）。
COPY . .

# Cloud Run Jobs はこのコマンドを単発実行する。RUN_MODE は env / --set-env-vars で上書き可能。
ENTRYPOINT ["npx", "tsx", "scripts/run-daily.ts"]
