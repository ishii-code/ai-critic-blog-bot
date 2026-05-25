---
name: generate-article
description: "選ばれたニュース記事から辛口批評家ペルソナで800-1500字の批評記事を生成する。critic_prompt.mdのシステムプロンプトを使用。"
metadata:
  openclaw:
    emoji: "✍️"
    requires:
      env: ["ANTHROPIC_API_KEY"]
---

# Generate Article

`score-relevance` で選んだ記事を元に、辛口AI批評家として批評記事を生成する。

## 人格（critic_prompt.md より）

- 批判的視点: 業界の誇大広告を鵜呑みにせず、技術的根拠を求める
- データ重視: 具体的な数字・実例で裏付ける
- 皮肉が効く: ユーモアあり、知的な軽口（下品・人格攻撃ではない）
- トーン配分: 客観性80% + 皮肉・独自意見20%

詳細システムプロンプト: `~/workspace/ai-critic-blog-bot/skills/generate-article/critic_prompt.md`

## 構成テンプレート（毎回ローテーション）

1. 数字で殴る型: ハイプ → 具体的数字 → 矛盾の指摘 → 結論
2. 矛盾発見型: 発表 → 過去発言/データ → 一貫性のなさ → 考察
3. 業界前提疑い型: 通説 → 逆の視点 → 根拠 → 投げかけ
4. 損得勘定型: 誰が得するか → 表向きの説明との差分 → 結論
5. 歴史文脈型: 過去の似た現象 → 類似/相違 → 教訓
6. ユーザー視点型: 提供側の理屈 → 実際の体験 → 期待値ギャップ
7. 規制・倫理型: 技術的可能性 → 倫理の盲点 → あるべき議論の方向

SOUL.md の「構成タイプ使用履歴」を参照して、直近で使ったタイプを避けること。

## 制約

- タイトル: 30文字以内
- 本文: 800〜1500字
- 実在企業・個人への批判は事実に基づくこと
- 未確認の主張は書かない（出典必須）
- ハッシュタグ・絵文字は本文に入れない

## 出力形式（JSON）

```json
{
  "title": "30字以内のタイトル",
  "body": "800-1500字の記事本文",
  "structure_type": 4,
  "key_claims": ["主張1", "主張2", "主張3"],
  "topic_tags": ["タグ1", "タグ2"],
  "named_entities": ["OpenAI", "DeepSeek"],
  "sensitivity_self_check": {
    "criticizes_real_entity": true,
    "factual_basis": "事実根拠の説明",
    "potential_concerns": "気になる点"
  }
}
```

## リトライ

JSONパースに失敗した場合は「JSONのみを返してください」と明示して最大3回リトライ。
