# `.claude/` — レビュワー定義

このディレクトリには**読み取り専用のレビュワー定義**だけを置いています。

| ファイル | 役割 |
|---|---|
| `agents/diff-reviewer.md` | 差分レビュー。`tools: Read, Grep, Glob` |
| `agents/security-reviewer.md` | セキュリティレビュー。`tools: Read, Grep, Glob` |

## なぜ必要だったか

このリポジトリの実装を **`ai-company` を cwd とするセッション**から行い、そこで
専用レビュワーを起動しようとしたところ、`ai-company` の read guard
（`scripts/claude-hook-read-guard.py`）が別リポジトリのファイル読み取りを拒否して
**レビュワーが起動できませんでした**。

guard は正しく動いています。`REPO_ROOT` をスクリプト自身の位置から決めるので、
`ai-company` のセッションにとってこのリポジトリは常に「repo 外」です。

そのとき使った回避策は「汎用エージェントに read-only を指示する」でした。
**これは等価ではありません。** 汎用エージェントは `Bash` を持つので、
「レビュワーはその変更を実行できなかった」がシステムの性質ではなく
**prompt の性質**に落ちます。

## 正しいやり方

**このリポジトリの変更は、このリポジトリを cwd とするセッションからレビューする。**

そうすれば capability がコードと同じ場所から来るので、どの guard も広げずに済みます。

```
cd ai-company-quest
# ここで Claude Code を起動し、diff-reviewer / security-reviewer を呼ぶ
```

## やってはいけないこと

**`ai-company` の read guard を広げて、あちらのセッションからここを読めるようにすること。**
それはレビュワーだけでなく**セッション内のすべての subagent** が他リポジトリを読めるように
なるという意味で、権限拡大かつ security boundary の変更です。レビュー道具の都合で
通す性質のものではありません。

## 判定の正本

`ai-company` の `docs/loop-control-plane/09-review-independence.md`。

- **A-1** … 「**誰が**レビューしたか」。実装した actor 自身は不可
- **A-6** … レビュワーは write / merge / approval の capability を持たない
- **A-7** … 「**そのレビュワーに何ができたか**」。shell / write / network を持つ actor の
  verdict は review evidence ではなく、**理由つきで記録される substitution**

A-1 と A-7 は独立です。**shell を持つ別 actor は、やはり別 actor**なので、
A-1 だけでは汎用エージェント代替を排除できません。

## 代替を使った場合に必ず書くこと

1. 代替が起きたこと、および**実際に走った agent type**
2. **専用レビュワーが持たない capability のうち、代替が持っていたもの**（shell / write / network）
3. 追跡 Issue

代替は「専用の read-only レビュワーでレビュー済み」とは**記述しません**。

## 未対応（follow-up）

このリポジトリには read guard そのものがまだありません。レビュワーは capability の面で
閉じていますが、`.env` 等を読もうとしたときに止める仕組みは無いということです。
public リポジトリで in-repo の secrets が無い現状では優先度は低く、追加するなら
`ai-company` の `forbidden_path_rules` に相当する述語をこちら側に持たせる形になります。
