---
name: safety-check
description: "生成された批評記事に法的・倫理的リスクがないか確認し、auto_publish / needs_approval / block の判定を返す。"
metadata:
  openclaw:
    emoji: "🔒"
    requires:
      env: ["ANTHROPIC_API_KEY"]
---

# Safety Check

`generate-article` の出力を独立した観点でチェックする。運用開始後2週間は安全閾値を厳しめに設定する。

## チェック観点（6項目）

1. **中傷的表現**: 実在企業・個人への人格攻撃や中傷がないか
2. **未確認の事実主張**: 「〜と判明」「〜が発覚」など根拠なき断定がないか
3. **名誉毀損リスク**: 具体的な犯罪行為や違法行為の主張がないか
4. **差別的表現**: 性別・人種・国籍などへの差別的表現がないか
5. **著作権侵害**: 長文引用や図表の無断使用がないか
6. **過度なクリックベイト**: 内容と乖離した煽り表現がないか

## 判定ロジック

- 上記 1-6 がすべて問題なし → `auto_publish`
- 1つでも「微妙」と判断 → `needs_approval`（安全側に倒す）
- 明確にアウト → `block`

## 出力形式

```json
{
  "decision": "auto_publish",
  "reasons": []
}
```

または:

```json
{
  "decision": "needs_approval",
  "reasons": [
    "観点1: 『○○社CEO』への表現が個人攻撃に近い",
    "観点3: 『黒字化していない』と断定しているが元ソースに記載なし"
  ]
}
```

## 運用調整

最初の2週間は `needs_approval` 率が高めになる想定。実績を見ながら閾値を緩める。
`needs_approval` の場合は現時点では投稿を保留し、ログに記録する（Slack承認はPhase 4で実装）。
