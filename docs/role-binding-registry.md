# Role Binding Registry（provisional・M0）

論理 role と provider adapter の束縛表です。**この文書はコードを変更しません。**
workflow / permissions / secrets / 依存 / runtime のいずれも定義・変更しません。
現在の provider 構成を**観測して記録するだけ**の成果物（本体設計の移行段階 M0 相当）です。

実装とこの文書が食い違った場合は、常に **実装（`src/`・`.github/workflows/`）が正**です。

関連: [loop-control-plane-design.md](loop-control-plane-design.md) /
[run-event-contract.md](run-event-contract.md) /
[provider-neutral-scan.manifest.json](provider-neutral-scan.manifest.json)

---

## 0. この文書の 2 つの責務

| # | 責務 |
|---|---|
| **1** | **provisional な Role Binding 表の権威**（§2）。`role -> { adapter_id, adapter_config_ref }` を宣言します |
| **2** | **禁止 provider token の唯一の権威 source**（§3）。[provider-neutral-scan.manifest.json](provider-neutral-scan.manifest.json) の `forbidden_tokens[]` は、本文書の宣言から**機械的に導出**した値です |

### 0.1 この file は provider 名を持ってよい唯一の契約文書です

本体設計の Provider Adapter 境界は、**provider 名が現れてよい場所を Role Binding に限定**しています。

```
Loop Control Plane
   │  role contract（provider 名なし）
   ▼
Role Binding        ← 本文書。provider 名が現れてよい唯一の場所
   │
   ▼
Provider Adapter    ← provider 固有の起動・prompt 組み立て・tool 名 mapping・失敗分類の正規化
   │
   ▼
provider runtime
```

したがって:

- **本 file は provider 中立検査の `include_paths` へ恒久的に入りません。** adapter / 設定 /
  Role Binding が provider 名を持つことは**責務**であって漏れではありません。
- 逆に、**中立であるべき契約文書に provider 名が現れたら、それは漏れ**です。
  その判定に使う token 集合を本文書が供給します。
- **「provider を変える」とは、§2 の表の行を差し替えることだけを意味します。**
  Loop Contract / Run State Machine / event code / evidence kind / Quest read model は変わりません。

### 0.2 provisional である理由

現時点で Loop Control Plane は実装されておらず、adapter registry も存在しません。
本表は **`.github/workflows/claude.yml` を観測して記録した現状**であり、
runtime が読む設定ではありません。実装時に正式な binding 設定へ引き継ぎます。

---

## 1. 論理 role（provider 非依存・正本）

**provider 名・model 名を role にしません。** 論理 role の定義は本体設計が正本です。

| role | 責務 | write 権限 |
|---|---|---|
| `PLANNER` | goal を実行計画へ分解し提案する | なし |
| `EXECUTOR` | 計画に沿って変更を作る | **あり**（branch への commit / push） |
| `REVIEWER` | 変更の正しさを検証する | なし |
| `RISK_ASSESSOR` | risk class を評価し、昇格を提案する | なし |
| `SECURITY_REVIEWER` | 安全境界・secret・権限の観点で検証する | なし |
| `HUMAN_REPORTER` | owner 向けの日本語報告を作る | なし |
| `RESEARCHER`（任意） | 事実確認・調査 | なし |

`OWNER` は **role ではありません**。人間の承認主体であり、binding の対象外です。
承認は OWNER のみが行い、上記のどの role も protected な state 遷移を authorize しません。

---

## 2. Role Binding 表（provisional）

| role | binding 状態 | `adapter_id` | `adapter_config_ref` | 観測根拠 |
|---|---|---|---|---|
| `PLANNER` | **BOUND（兼務）** | `claude_code_action_v1` | `.github/workflows/claude.yml` の `Run Claude Code` step | `claude.yml:150-155`、`:173-175` |
| `EXECUTOR` | **BOUND（兼務）** | `claude_code_action_v1` | 同上 | 同上 |
| `REVIEWER` | **BOUND（兼務・非独立）** | `claude_code_action_v1` | 同上 | 同上 |
| `REVIEWER` | **BOUND（独立）** | `chatgpt_codex_connector_review` | `allowed_bots` に列挙された connector App | `claude.yml:157-163`、`:42-43` |
| `RISK_ASSESSOR` | **BOUND（兼務）** | `claude_code_action_v1` | 同上 | `claude.yml:150-155` |
| `HUMAN_REPORTER` | **BOUND（兼務）** | `claude_code_action_v1` | 同上 | 同上 |
| `SECURITY_REVIEWER` | **UNBOUND** | — | — | role として存在しません（観測できる binding がありません） |
| `RESEARCHER` | **UNBOUND** | — | — | 任意 role。binding がありません |

### 2.1 この表が記録している構造的な事実

- **`claude_code_action_v1` の 1 run が `PLANNER` / `EXECUTOR` / `REVIEWER` /
  `RISK_ASSESSOR` / `HUMAN_REPORTER` を同時に兼務**しています。
  これは「変更した主体が自分の変更を検証する」構造そのものです。
  role 分離は provider を増やすためではなく、この構造を解消するために必要です。
- **独立した検証主体は `chatgpt_codex_connector_review` が唯一**です。
- **`SECURITY_REVIEWER` と `RISK_ASSESSOR` は独立した binding を持ちません。**
- **本表は現状の記録であって、是正ではありません。** 是正は後続の実装 PR の範囲です。

### 2.2 adapter の責務と非責務（再掲・変更なし）

| adapter の責務 | adapter の**非**責務 |
|---|---|
| provider 固有の起動・認証の扱い | state 遷移の決定 |
| role の input schema → provider 入力への変換 | approval の判定 |
| provider 出力 → role の output schema への変換 | risk 分類の決定 |
| provider 固有の失敗を共通の failure type へ正規化 | retry 回数の決定 |
| provider 固有の進捗を core event code へ写像 | evidence の合否判定 |

**adapter は core event を生成できますが、core event に provider 固有 field を足せません。**

---

## 3. Provider registry（`forbidden_tokens[]` の権威 source）

行ごとに **`provider_id` / vendor・brand alias / model family・brand alias** を宣言します。
[provider-neutral-scan.manifest.json](provider-neutral-scan.manifest.json) の
`forbidden_tokens[]` は、**下表の宣言 token の和集合を実体化した値**です。

| # | `provider_id` | vendor token | brand alias | model family / brand alias | 宣言根拠 |
|---|---|---|---|---|---|
| 1 | `anthropic` | `anthropic` | `claude` | `opus` / `sonnet` / `haiku` | `claude.yml:153`（action 名）、`:174`（pin された model 名）。model family は brand の family 名として宣言（§3.2） |
| 2 | `openai` | `openai` | `chatgpt` / `codex` | `gpt` | `claude.yml:163`、`:42-43`（connector App の actor login）。vendor token は owner 宣言（§5.1 の未確認事項） |

### 3.1 導出規則（機械的・解釈を挟まない）

| 規則 | 内容 |
|---|---|
| T-1 | `forbidden_tokens[]` = §3 表の **vendor token ∪ brand alias ∪ model family / brand alias** の和集合 |
| T-2 | 導出時に **NFKC → 小文字化 → `[-_./ ]` の連続を半角空白 1 個へ畳む** 正規化を適用し、正規化後の値を実体化します |
| T-3 | 重複は 1 件へ畳みます。順序は結果に影響しません |
| T-4 | **意味的カテゴリの解釈を行いません。** 「provider っぽい語」を scan 側が推論することを禁じ、manifest の値だけを読ませます |
| T-5 | **provider の live API を参照しません。** 実体化は本文書の宣言のみから行います |
| T-6 | `provider_id` / `adapter_id` / `adapter_config_ref` に現れる語も、上表で宣言された token に還元されます。**adapter_id を根拠に新しい token を足しません** |

**現時点の実体化結果は 9 件**です（`anthropic` / `claude` / `opus` / `sonnet` / `haiku` /
`openai` / `chatgpt` / `codex` / `gpt`）。manifest 側の値と一致していなければ FAIL です（§4）。

### 3.2 model family を bind 済みのものに限定しない理由

現在 pin されている model は 1 つですが、**同一 brand の他の family 名が中立面へ漏れた場合も
検出できなければ意味がありません**。「まだ使っていないから token に入れない」とすると、
使い始めた瞬間に検査が素通りします。

したがって model family token は **brand が持つ family 名として宣言**し、
binding 状態と切り離します。これは検査を広げるだけで、除外を広げません。

### 3.3 token を足す / 減らすときの規則

| 規則 | 内容 |
|---|---|
| T-7 | provider を追加・撤去する PR は、**同じ PR で §3 の行を追加・削除**します |
| T-8 | token の**削除は検査を弱めます**。削除する PR は、その token を持つ provider がもはや binding にも過去 run にも現れないことを本文書に記録します |
| T-9 | §3 を変更した PR は、**同じ PR で manifest の `forbidden_tokens[]` と `token_source_digest` を再実体化**します（§4） |

---

## 4. manifest との同期（digest）

manifest は `token_source_ref` / `token_source_digest` により、本文書との同期を検証します。

| 項目 | 値 |
|---|---|
| `token_source_ref` | `docs/role-binding-registry.md`（本文書。**唯一の権威 source**） |
| digest algorithm | **SHA-256**。対象は**本 file の raw byte 列全体**（改行を含む） |
| 表現 | `sha256:` + 小文字 16 進 64 文字 |
| 判定 | `token_source_digest` が本 file の実内容と**一致しない場合は FAIL** |

この規則は「registry を更新したのに manifest を再実体化していない」状態を検出するためのものです。
**digest 値は manifest 側にのみ置きます。** 本文書に自分自身の digest を書くと循環します。

---

## 5. 例外（exception）に対する本文書の立場

- 例外の宣言・保持は **manifest の `exceptions[]`** が行います。本文書は token だけを供給します。
- **広いディレクトリ除外の代わりに、1 件ずつ記録**します。
- **例外の追加・延長は OWNER の承認事項**です。role による検証は承認ではありません。
- **除外は「見逃してよい」ではありません。** 除外面に provider 名が増えること自体は正常で、
  検査が見ているのは「中立面へ漏れたか」だけです。

### 5.1 恒久的に `include_paths` へ入れない面（名指し）

| path | 理由 |
|---|---|
| `docs/role-binding-registry.md` | 本文書。provider 名を持つことが責務です |
| `docs/provider-neutral-scan.manifest.json` | `forbidden_tokens[]` を実体化して保持するため、定義上必ず hit します |
| `docs/loop-control-plane-design.md` | 設計・説明のため provider 名を含みます |
| `docs/live-wire-contract.md` | 外部 wire = adapter 面の mapping 表です |
| `docs/org-snapshot-design.md` | 設計文書 |
| `docs/cost-governance-roi-design.md` | 設計文書（本体設計への追補） |
| `README.md` | 運用説明のため provider 名を含みます |
| `.github/workflows/**` | provider 固有の起動設定そのものです |
| `test/**` と fixture | 外部 wire の再現を含みます |
| Provider Adapter の実装・設定（`src/domain/hookWire.ts` / `src/domain/hookAdapter.ts` を含む） | adapter 境界そのものです |

---

## 6. 観測できていないこと（推測で埋めない）

| # | 項目 | 状態 |
|---|---|---|
| 1 | `provider_id = openai` という vendor 識別子の正式表記 | **このリポジトリからは観測できません。** 観測できるのは connector App の actor login（`claude.yml:163`、`:42-43`）だけです。vendor token は owner 宣言として置いており、正式表記が違う場合は §3 の行を差し替えます |
| 2 | 独立 REVIEWER が実際にどの model / 構成で動いているか | このリポジトリからは `allowed_bots` の列挙以上のことが観測できません |
| 3 | `SECURITY_REVIEWER` / `RISK_ASSESSOR` を独立 binding にする場合の provider | 未決。本表は現状の記録のみです |
| 4 | 過去 run が使用した model の履歴 | 永続 Run / Event Store が存在しないため観測できません |
| 5 | adapter registry の物理形式（設定 file か code か） | 実装 PR の範囲です |

---

## 7. この文書の対象外

- adapter の**実装**、binding の runtime 適用、adapter registry の物理形式
- provider の移行そのもの、provider の追加・撤去
- provider 中立 scan を走らせる **CI の実装**（後続 WF-1・分類 C）
- `.github/workflows/**` / hooks / permissions / secrets / 認証の変更
- provider 価格表・単価・課金仕様（cost 追補の非目標のまま）
- 外部 repository / 外部 service への接続
