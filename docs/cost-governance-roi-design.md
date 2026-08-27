# Cost Governance / AI ROI Management 設計記録

**Loop Control Plane 設計への追補（additive amendment）。** この文書はコードを変更しません。
runtime挙動、wire schema、SSE frame、環境変数、依存、workflow のいずれも定義・変更しません。
実装とこの文書が食い違った場合は、常に実装（`src/`）が正です。

関連: [loop-control-plane-design.md](loop-control-plane-design.md)（本体） /
[org-snapshot-design.md](org-snapshot-design.md) /
[event-contract.md](event-contract.md) / [live-wire-contract.md](live-wire-contract.md)

---

## 0. この文書の位置づけと、分離した理由

Loop Control Plane 設計（`loop-control-plane-design.md`）が定めた
責務境界 / Loop Contract / Run State Machine / Event schema原則 / Evidence Bundle /
risk・承認policy / Agent Contract / Provider Adapter境界 / 言語policy /
Quest・Management Console・Control Plane の責務分離 を**前提として引き継ぎ**、
そこへ **Cost Governance** と **AI ROI Management** を正式なプロダクト要件として追加します。

**本体文書の設計判断は1つも撤回しません。** 特に次は不変です。

- Quest は Control Plane ではなく **read model / experience layer**
- Quest runtime は **read-only / GETのみ / loopback限定 / CORS header無し**
- 論理 role が正本で、provider 名は Role Binding の1行に閉じる
- risk の**昇格は自動・降格は owner 承認必須**（monotonic escalation）
- deterministic code が state 遷移・idempotency・承認有無・停止条件を所有する

### 0.1 なぜ本体へ直接書かず、別 file にしたか（事実）

本 run の checkout は `main`（`b29611c`）から切られた作業ツリーで、
**前 run の成果物 `docs/loop-control-plane-design.md` を含んでいません**。
`git fetch` / `git ls-remote` / `gh api` はいずれも本 run の tool 権限で実行できませんでした。

846行の本体文書を**推測で再構築すると実ファイルと食い違う**ため、それは行わず、
**同一 branch へマージしても競合しない追補 file** として作成しています。
本文書は本体の章番号を引用せず、**章の題目（責務境界 / Evidence Bundle 等）で参照**します。
題目は安定していますが番号は変わり得るためです。

owner 側で本体と本追補を1 branch に揃えた後、本文書を本体へ節として取り込むか、
関連文書として並置するかを選べます。**どちらでも設計内容は変わりません。**

これは本体文書の Prompt/Context/Harness/Loop 監査が指摘した
「prompt が要求する context を harness が取得させない」の実例でもあります（→ §12.2）。

### 0.2 このrepositoryで確認した現在地（事実）

| 項目 | 観測 | 正本 |
|------|------|------|
| HEAD | `b29611c`（重複 issue-trigger 修正 #18 マージ済み） | `git log` |
| 依存 | ゼロ。`package-lock.json` は意図的に空 | `package.json` |
| test | 338 pass / 0 fail | `npm test` |
| typecheck | pass | `npm run typecheck` |
| endpoint | GETのみ7本。state を変更する endpoint は無い | `README.md:113-126` |
| wire keys | 19 key の whitelist。**cost / usage / token / price に相当する key は1つも無い** | `src/domain/wire.ts:39` |
| 内部 event model | 必須keyに usage も cost も無い | `docs/event-contract.md` Keys表 |
| state | `QuestState` は7 field。cost を載せる枠は無い | `src/domain/reducer.ts:113` |
| 秘匿境界 | raw prompt / raw command / 絶対path / secret / 内部reasoning は保存も配信もしない | `README.md:373-374` |

**したがって Cost Governance は「既存の何かを直す」話ではなく、
「現時点で1 byte も存在しないものを、後から大改修せずに足せる形で先に決めておく」話です。**
この文書が今やるのはそれだけで、実装は行いません。

---

## 1. Product positioning — 4本柱

AI Company OS が目指すのは **agent の監視画面でも、請求額の表示画面でもありません**。
企業の **AI経営・AI投資** を管理する **Control Plane** です。

その中核を次の4本柱として正式に位置づけます。

| 柱 | 問い | 所有する主体 |
|----|------|--------------|
| **Security Governance** | この操作は許されるか。何に触れてよいか | deterministic Loop Control Plane（policy / permission / tool allowlist） |
| **Cost Governance** | いくら使ったか。誰の予算か。止めるべきか | deterministic Loop Control Plane（budget policy評価・停止判断） |
| **Human-on-the-Loop** | 人間はどこで介入するか。何を承認するか | deterministic Loop Control Plane（approval gate） + Management Console |
| **ROI Management** | それは価値を生んだか。いくらの価値か | Management Console（分析） + Run/Event Store（evidence） |

4本柱は互いに独立ではありません。**Cost Governance の閾値超過は、
Security Governance と同じ approval gate と同じ停止機構を使います。**
cost 専用の停止経路を新設しません。新設すると「止まる理由」が2系統になり、
監査証跡と kill switch が二重化するためです。

> **Cost は risk の入力の1つです。** 本体文書の risk 再評価（実装 diff 発生後の
> `RISK_CLASSIFIED` 2回目）と同じく、**cost 見積りが変わったら risk も再評価され得る**
> という接続を持ちます。予算超過は「保護対象操作の前で止まる」理由として、
> 既存の C 分類（Human-in-the-Loop 承認必須）へ写像します。

---

## 2. 責務境界（Cost 軸）

本体文書の責務境界表へ、cost/value の観点を**追加**します。層は増やしません。

| 層 | Cost / ROI における責務 | **持たない**もの |
|----|------------------------|-----------------|
| **Company Brain** | 顧客・部署・業務カテゴリ・価値評価方法論といった**永続的な業務知識** | 個々の run の消費額（ephemeral run state ではない） |
| **Loop Control Plane**（deterministic） | budget policy の**評価**、閾値判定、承認要否の決定、停止/中断の決定、監査 evidence の記録 | 価格表そのもの、provider 固有の課金仕様 |
| **Agent Workers** | 自分の消費を**報告**する。予算判断はしない | 「予算内かどうか」の判断権限。agent の自己申告は判断の入力であって判断ではない |
| **Provider Adapters** | provider 固有の usage / pricing 事実を**正規化**する | 論理 role の定義、budget policy |
| **Run / Event Store** | attribution 可能な usage / cost evidence を**永続保持**する | 集計ロジック、閾値判断 |
| **GitHub** | diff / PR / CI / merge の evidence | 消費額の real-time database ではない |
| **Management Console** | cost / budget / ROI の**詳細分析と介入**。Task/Workflow/Department/Role/Provider/Model 軸の比較 | enforcement の最終権限（Control Plane が持つ） |
| **Quest** | **read-only / experience layer のまま。** 将来 cost の要約を projection してもよい | **budget enforcement の権限を一切持たない** |

### 2.1 Quest の境界（再確認・緩めない）

将来 Quest に「今月の消費率」のような要約が出ることは設計上あり得ます。ただし:

- Quest が出すのは **Control Plane が既に判断した結果の投影**です。Quest が閾値を評価しません。
- Quest に **POST / 予算変更 / 停止操作 / 承認操作の導線を追加しません。**
  既存 SSE surface に control endpoint を足すことも行いません。
- 将来 mutation が必要になった場合の経路は本体文書のとおり
  `Quest / Management UI → authenticated Control API → Policy/Approval Gate → Executor` のみです。
- Quest に届く cost 値は **閉じた語彙のstatus + 数値**であり、provider 固有の自由記述文字列は届きません
  （`README.md:216` の「wireの自由記述をそのまま表示しない」を cost にも適用）。

### 2.2 agent の自己申告を信用しない理由

LLM agent は自分の token 消費を正確に知りません（cache hit、tool 内部呼び出し、
retry、provider 側の切り上げを観測できない）。したがって:

- **正本は provider adapter が正規化した観測値**であり、agent の自己報告ではありません。
- agent の報告は `attribution_method` を明示した**補助的 evidence** として扱います。
- **deterministic code が最終的に採用値を決めます。** これは本体文書の
  「agent は提案できるが、deterministic code が所有・検査する」原則の cost 版です。

---

## 3. 最小の future-proof evidence model — Usage / Cost Attribution Envelope

**目的は「今すぐ集計できること」ではなく、「後から集計したくなったときに、
過去のデータを捨てずに済むこと」です。**

現時点で必要なのは、**どの軸で後から集計されても耐える attribution 情報**を
1件の消費事実に添えられる、という保証だけです。集計・保存・表示はすべて後続フェーズです。

> **現行 wire protocol は変更しません。** 以下は概念上の envelope であり、
> `src/domain/wire.ts` の19 key にも `docs/event-contract.md` の Keys 表にも追加しません。
> 実際の field 名・型・必須性は **LCP-1（Run/Event contract v1）で決めます**（§9）。

### 3.1 envelope が持つ次元

| 次元 | 必須 / 任意 | 内容 | 不明時 |
|------|------------|------|--------|
| `tenant_id`（顧客/テナント識別子） | **必須** | 課金の帰属先 | `unattributed` を明示（後述 §3.3） |
| `project_id` | 任意 | project 単位の予算がある場合のみ | `null` |
| `run_id` | **必須** | Loop Control Plane の run 識別子 | 消費が run 外なら `null` + `attribution_scope` で明示 |
| `task_id` | 任意 | run 内の task | `null` |
| `workflow_id` | 任意 | workflow 定義 | `null` |
| `logical_role` | **必須** | `PLANNER` / `EXECUTOR` / `REVIEWER` / `RISK_ASSESSOR` / `SECURITY_REVIEWER` / `HUMAN_REPORTER` 等の**論理 role**（本体文書の Agent Role Model） | `unknown_role` を明示 |
| `business_category` | 任意 | 業務カテゴリ（営業支援 / 開発 / 問い合わせ対応 等） | `null` |
| `department_id` | 任意 | 部署。`org-snapshot-design.md` の区画識別子と**同じ値域**を使う | `null` |
| `agent_instance_id` | 任意 | **dynamic agent の実体識別子**（§5） | 固定 agent や instance を持たない場合は `null` |
| `provider_id` | **必須** | adapter 境界の**内側**で正規化された provider 識別子 | 不明なら記録を拒否（推測しない） |
| `model_id` | **必須** | 同上 | 同上 |
| `usage_quantities` | **必須** | provider が報告した単位付き数量の集合（input / output / cache_read / cache_write / tool_call / seconds など）。**単位を値と分離して保持する** | provider が報告しない単位は key ごと欠落させる（0 で埋めない） |
| `service_cost_items` | 任意 | tool / 外部 service の費用（検索 API、sandbox 実行時間 等） | `null` |
| `cost_amount` | 任意 | 金額 | 未算出なら `null`（0 にしない） |
| `cost_currency` | `cost_amount` があれば必須 | **ISO 4217**。provider が請求した通貨をそのまま | — |
| `cost_status` | **必須** | `estimated` / `finalized` / `unpriced` の**閉じた語彙** | `unpriced` |
| `pricing_source` | `estimated` / `finalized` なら必須 | 価格の出所（provider 請求 / 価格表 version / 契約単価）と `effective_at`、または evidence reference | — |
| `occurred_at` | **必須** | 消費が発生した時刻（ISO-8601） | — |
| `recorded_at` | **必須** | Store が記録した時刻。**`occurred_at` と別 field**（遅延請求の判定に使う） | — |
| `evidence_ref` | **必須** | 本体文書の Evidence Bundle への参照（run/event id、provider 明細 id 等） | — |
| `schema_version` | **必須** | envelope の version | — |

### 3.2 必須と任意を分けた基準

**必須にしたのは「後から復元できないもの」だけです。**

- `tenant_id` / `run_id` / `logical_role` / `provider_id` / `model_id` /
  `occurred_at` は、その時点で記録しないと**永久に復元できません**。
- `department_id` / `business_category` は Company Brain 側の対応表から
  **後から join できる**ため任意です。
- `cost_amount` は価格表があれば `usage_quantities` から**後から算出できる**ため任意です。
  **逆に `usage_quantities` は必須です**（後から観測し直せないため）。

この非対称性が「最小限」の定義です。金額ではなく**数量と帰属**を先に確保します。

### 3.3 未帰属・不明を「捏造しない」規則

このrepositoryの既存原則（`README.md:170` の `unattributed`、
`src/domain/actor.ts:78` の「fallbackも推測もしない」）を cost にもそのまま適用します。

- 帰属先が決まらない消費は **`unattributed` という明示的な値**を持ちます。
  適当な tenant へ割り振ることも、按分することも、黙って捨てることもしません。
- 不明な次元は `null` であって `"unknown"` という**文字列でも 0 でもありません**。
  0 は「消費が無かった」という別の事実です。
- **`unattributed` の総額は常に集計可能でなければなりません。**
  「合計が合わない」を検知できないと、帰属漏れが静かに蓄積します。
- 未帰属分を後から帰属させ直す場合、元の record を上書きせず
  **訂正 record を追加**します（監査証跡の追記のみ・本体文書の audit trail 原則）。

### 3.4 保持してはいけないもの

**cost 計上のためだけに、prompt 本文・secret・credential・機微payload を保持しません。**

`README.md:373-374` は既に「raw prompt、raw command、絶対path、secret/credential、
内部reasoningは保存も配信もしない」と定めています。cost はこの境界を緩める理由になりません。

- token 数を数えるのに prompt 本文は不要です。**数量だけを保持します。**
- provider 明細の照合は **id 参照**で行い、明細本文を複製しません。
- 拒否理由・異常検知の理由は、既存の halt reason と同じく
  **field名 + rule名のみ**で、内容文字列を含めません。

---

## 4. Provider Independence と通貨

### 4.1 provider / model は次元であって、role でも event 名でもない

本体文書の Provider Independence 原則の cost 版です。

- `provider_id` / `model_id` は **集計軸（dimension）**です。
- **event code / state code に provider 名を入れません。**
  `ANTHROPIC_TOKENS_BILLED` のような code を作らず、`USAGE_RECORDED` のような
  provider 非依存の code に `provider_id` を**属性として**載せます。
- **論理 role は provider から独立です。** `PLANNER` の provider が変わっても、
  `logical_role = PLANNER` の集計は連続します。これが「provider を替えても
  過去の ROI 比較が壊れない」ことの実体です。
- provider 固有の usage 単位名（provider ごとに異なる cache 種別など）は
  **adapter が正規化**します。正規化できない単位は `unmapped` として
  数量を保持しつつ**捨てません**（後から mapping を足せるように）。

このrepositoryには既に同型の実装先例があります:
`hookWire.ts`（外部wireのmodel）→ `hookAdapter.ts`（mapping表の行だけを使う）
→ `validate.ts`（内部契約で再検証）の3段構成（`README.md:368-370`）。
**cost adapter も同じ形を採り、新しい枠組みを発明しません。**

### 4.2 通貨

- **provider が請求した通貨と金額を原本として保持します。** 上書きしません。
- reporting 通貨への換算は**別 field**で持ち、必ず
  **FX rate / rate source / effective time** を伴います。
- 換算結果しか残っていない状態を作りません。rate が後から訂正された場合、
  原本があれば再計算できますが、原本を失うと復元不能です。
- **現在の provider 価格を core domain contract へ hard-code しません。**
  価格は Company Brain / 設定側の**版付きデータ**であり、契約の定数ではありません。
  価格表そのものは本タスクでも後続 contract PR でも作りません（§11）。

---

## 5. Dynamic Agent の attribution

「固定のAI社員」だけを前提にしません。task ごとに生成され、終了とともに消える
**dynamic agent** が主要な消費者になり得ます。

### 5.1 2つの粒度を同時に成立させる

| 粒度 | 内容 |
|------|------|
| **instance-level** | ephemeral な agent instance 1件ごとの消費。`agent_instance_id` で識別 |
| **aggregate-level** | 論理 role / 業務カテゴリ / workflow / task / department / provider / model による集計 |

instance は消えても、**集計軸の値は envelope に焼き込まれている**ため
集計は後から成立します。これが「instance 単位」と「role 単位」を両立させる仕組みです。

### 5.2 恒久的な「社員」record を要求しない

**cost 帰属のために、永続的な employee identity を必須にしません。**

`org-snapshot-design.md` §4.2 は「roster社員 ↔ runtime actor の照合key」を
**未決**としています。cost 設計がその未決に依存すると、org 定義（`company/org.yaml`）の
実在確認が済むまで cost telemetry が一切始められません。

したがって:

- **cost の必須帰属軸は `logical_role` であって employee id ではありません。**
- roster が存在すれば `department_id` などが埋まり、集計が richer になります。
- roster が無くても cost の記録・集計は**成立します**（degraded ではなく、軸が少ないだけ）。

これは Quest 側の既存原則
（`{session_id}:main` は構造上の事実のみを意味し、役職を推測しない、`README.md:379-380`）と
同じ姿勢です。**存在しない組織構造を cost のために捏造しません。**

---

## 6. Budget Policy（概念のみ）

### 6.1 policy が持つ概念

顧客 / project 単位で:

| 概念 | 内容 |
|------|------|
| budget period | 予算の期間（月次を含むが、月次に限定しない） |
| limit | 上限額と通貨 |
| spend to date | 期間内の確定 + 見積り消費額（**両者を分けて保持**） |
| remaining | 残高 |
| consumption ratio | 消化率 |
| forecast | 期末見込み。**算出方法とその前提を必ず併記** |
| actions | 閾値ごとの動作（警告 / 承認要求 / 停止） |
| anomaly detection | 異常増加の検知 |
| audit trail | 判断の入力・policy version・結果の追記型記録 |

### 6.2 閾値は定数ではなく設定可能な policy

**「80% で警告」「100% で承認要求」は既定候補（default policy candidate）であって、
不変の定数ではありません。**

- 本タスクでも後続 contract PR でも、**閾値を hard-code しません。**
- policy は **version を持ち**、判断 record は「どの policy version で判断したか」を残します。
  policy が変わっても過去の判断が再現できるためです。
- 顧客ごと・project ごとに異なる閾値、複数段の閾値、期間途中の変更をいずれも許す形にします。

### 6.3 停止・承認は既存の gate へ写像する

cost 専用の停止経路を新設しません。

| cost 事象 | 写像先 |
|-----------|--------|
| 警告閾値到達 | 人間向け通知（日本語）。run は止めない |
| 承認閾値到達 | **risk 分類 C 相当**へ昇格 → 保護対象操作の**前**で Human-in-the-Loop 承認待ち |
| 停止条件到達 | 本体文書の stop condition / kill switch。既存の停止機構をそのまま使う |
| 異常増加検知 | risk 再評価の trigger。自動昇格は可、**自動降格は不可**（monotonic escalation） |

**昇格・降格の非対称性は cost でも同じです。** 予算判断による昇格の誤りは
「余計に止まる」だけですが、降格の誤りは「止まるべき所で止まらない」になります。

### 6.4 fail-safe — 請求データの欠落と遅延

**これが cost 設計で最も間違えやすい箇所です。**

provider の確定請求は遅れて届きます。見積りしか無い時点で
「現在の正確な消費額」と称してはいけません。

- 表示・判断・報告は常に **`estimated` / `finalized` を区別**します（§3.1 の `cost_status`）。
  混在した合計は「うち見積り X 円」を必ず併記します。
- **請求データが欠落・遅延している間の既定挙動を policy として明示的に決めます。**
  選択肢は「見積りで判断を続ける」「保守側へ倒して承認要求へ昇格する」「停止する」で、
  **黙って「消費0」として扱うことだけは禁止**です。0 と「不明」は別の事実です。
- 確定額が見積りと乖離した場合、見積り record を上書きせず**訂正 record を追加**し、
  遡って閾値超過が判明した場合の扱い（次期間へ持ち越すか、即時昇格か）を policy に持ちます。
- `recorded_at` と `occurred_at` を分けているのは、この遅延を**測定可能にする**ためです。

---

## 7. Business Value Model

**`cost` と `business_value` は別の contract です。** 同じ record に混ぜません。

理由は単純で、cost は provider が報告する**観測値**ですが、
business value は人間が方法論を選んで**推定する値**だからです。
同じ table に置くと、推定が観測の顔をして流通します。

### 7.1 value record が持つ概念

| 概念 | 内容 |
|------|------|
| `value_metric_type` | 価値指標の種別（§7.2 の閉じた語彙） |
| `baseline` | 比較基準。**baseline が無い value は成立しません** |
| `observed` | 観測値 |
| `unit` | 単位（時間 / 件 / 率 / 通貨） |
| monetary conversion | 任意。金額換算する場合は**換算率と根拠**を必ず伴う |
| `measurement_window` | 測定期間 |
| `attribution_method` | 帰属方法（AI の寄与をどう切り出したか） |
| `confidence` / quality | 確度。**推定であることを消さない** |
| `methodology_version` | 方法論の版。版が変われば過去値と単純比較しない |
| `evidence_ref` | 裏付け evidence への参照 |

### 7.2 value metric type（少なくともこれらを区別する）

| type | 内容 | 実現性 |
|------|------|--------|
| `time_saved` | 削減時間そのもの | 観測寄り |
| `time_value_proxy` | 削減時間 × 単価による**代理**金額 | **推定** |
| `realized_cost_saving` | 実際に発生しなくなった費用 | **実現** |
| `revenue_contribution` | 売上寄与 | 帰属方法に強く依存 |
| `gross_profit_contribution` | 粗利寄与 | 同上 |
| `quality_error_reduction` | エラー・欠陥の削減 | 観測寄り |
| `response_time_improvement` | 対応時間の短縮 | 観測寄り |
| `throughput_improvement` | 処理件数の増加 | 観測寄り |

**商談獲得のような事象も、`revenue_contribution` の帰属方法として扱い、
専用の特別扱いを作りません**（軸を増やすほど比較不能になるため）。

### 7.3 推定を実現利益として提示しない

- `time_value_proxy` は **代理指標**です。人件費が実際に減っていない限り、
  `realized_cost_saving` ではありません。両者を同じ合計に足しません。
- 集計・報告では **実現 / 推定を分けた小計**を必ず出します。
- `confidence` を落として合計だけを見せる表示を作りません。
- 人間向け報告（日本語）でも「推定」「前提」を明示します
  （本体文書の言語policy: 人間向け要約は日本語、機械間は schema）。

---

## 8. ROI 用語

**「ROI 13倍」のような曖昧な表記を使いません。** 分子・分母が読み手ごとに違うためです。

| 用語 | 定義 |
|------|------|
| **benefit-cost ratio** | `business_value / ai_cost` |
| **net ROI** | `(business_value - ai_cost) / ai_cost` |
| **payback period** | 投資が回収されるまでの期間。**継続投資型では適切な場合にのみ**用いる |

例（前提を明示した上での計算）:

> business value 40,000 円、AI cost 3,000 円のとき
> - benefit-cost ratio ≈ **13.3倍**
> - net ROI ≈ **12.3倍**（約 **1,233%**）
>
> この2つは同じ状況を指しますが**数値が異なります**。どちらを指すか明示せずに
> 「13倍」とだけ書くことを禁じます。

規則:

- 報告時は **用語名を必ず併記**します（「benefit-cost ratio 13.3倍」）。
- **`business_value` に推定が含まれる場合、その旨と推定の内訳を併記**します。
- **`ai_cost` に `estimated` が含まれる場合も同様**です（§6.4）。
- `methodology_version` が異なる期間の比率を、断りなく時系列比較しません。
- `ai_cost = 0` のとき比率を計算しません（無限大を表示しない。`unpriced` と表示）。

---

## 9. ロードマップ配置

本体文書のロードマップを**置き換えません**。cost/value を既存の順序へ**差し込みます**。

### 9.1 既存ロードマップとの関係

| 既存項目 | 変更 |
|----------|------|
| 本 Issue #19 PR | **docs のみのまま。** 変更なし |
| `org-snapshot-design.md` PR-1〜PR-5 | **supersede なし・順序変更なし。** cost 設計は roster の実在に依存しません（§5.2） |
| **LCP-1**（Run/Event contract v1） | **範囲を最小限拡張**（§9.2）。依然として分類 A・code 変更なし |
| 本体文書の後続フェーズ（read-only Management Console、Run/Event Store、deterministic controller、Eval / observer、authenticated intervention） | 順序不変。cost の各段はこれらに**従属**する（§9.3） |

### 9.2 LCP-1 への追記（次の1件・分類 A）

LCP-1 は state code / event code / evidence kind / 失敗種別の**閉じた語彙**を確定する
docs タスクでした。ここへ **additive / optional** として次を加えます。

- **usage/cost attribution envelope の次元名と必須・任意の別**（§3.1 / §3.2）
- **`cost_status` の閉じた語彙**（`estimated` / `finalized` / `unpriced`）
- **`unattributed` / `unknown_role` の扱い**（§3.3）
- **usage event の evidence linkage**（Evidence Bundle への参照方法）
- **provider 非依存の event code 命名規則**（provider 名を code に入れない・§4.1）

**なぜ LCP-1 に入れるのか**: event code の語彙が先に固まってしまうと、
後から cost を足すときに **provider 名入りの code や、帰属軸を持たない usage event が
既に流通している**状態になります。そうなると provider 置換が read model まで波及します。
語彙が未確定な**今だけ**が、無償で入れられる時点です。

**なぜ「範囲を最小限拡張」に留めるのか**: 集計・保存・表示・enforcement を
LCP-1 に含めると、docs-only ではなくなり、Quest MVP の前に大きな設計が挟まります。
**contract だけを先に置き、実装は全部後ろへ送ります。**

### 9.3 cost/ROI の後続 PR 候補（依存順・A/B/C/D 推定）

| id | 内容 | 前提 | 推定分類 |
|----|------|------|----------|
| **COST-0** | LCP-1 内の attribution contract（§9.2）。**次の1件に同梱** | 本 PR | **A**（docs） |
| **COST-1** | 低コストな telemetry の取得と正規化。provider adapter が usage を正規化して記録するところまで。**Quest MVP を止めない**。UI 変更なし | COST-0 受理 | **B**（code / runtime影響） |
| **COST-2** | read-only の cost / budget projection。集計は行うが**判断も enforcement もしない** | COST-1 が信頼できる telemetry を出していること | **B** |
| **COST-3** | deterministic budget enforcement（閾値判断・承認要求・停止） | Policy / Approval / Stop の基盤（本体文書の該当フェーズ）＋ 価格品質規則（§6.4） | **C**（保護対象操作を止める権限を持つため owner 承認必須） |
| **VALUE-1** | business value の baseline と方法論の定義（docs） | COST-0 | **A** |
| **VALUE-2** | value capture と ROI 算出 | VALUE-1 で baseline / methodology が確定していること | **B** |
| **MC-COST** | Management Console の cost / budget / ROI dashboard | Management Console フェーズ | **B**（read-only の間）／介入を含めるなら **C** |

**順序の要点**:

- **COST-1 は COST-0 が受理されるまで着手しません。** contract 未確定の telemetry は
  後で全部書き直しになります。
- **COST-2 は COST-1 の telemetry が信頼できると確認できるまで着手しません。**
  欠測のある数字を集計画面に出すと、`estimated` の断り書きが読まれずに定着します。
- **COST-3 は Policy / Approval / Stop 基盤より後です。** これを先に作ると
  cost 専用の停止経路が生まれ、§1 で避けたはずの二重化が起きます。
- **完全な dashboard は Management Console フェーズまで延期**します。

### 9.4 次の1件（改訂後）

**LCP-1（Run / Event contract v1 の docs 化）+ COST-0（attribution contract の追記） — 分類 A**

前回 run の推奨（LCP-1）を**変更しません**。範囲に COST-0 を足すだけです。
code 変更ゼロ、runtime 影響ゼロ、338 test に影響ゼロ、owner 承認不要のままです。

---

## 10. Architecture acceptance criteria（cost / ROI 追加分）

本体文書の受け入れ基準へ追加します。既存基準は変更しません。

| # | 基準 |
|---|------|
| C1 | **Provider / Model を替えても、core の cost / value contract が変わらない。** provider 名は dimension の値としてしか現れない |
| C2 | **全ての cost は帰属されるか、明示的に `unattributed` と記録されるかのいずれかである。** 黙って消える cost が存在しない。`unattributed` の総額が常に集計できる |
| C3 | **`estimated` と `finalized` を混同できない。** 合計値は必ず内訳を持ち、片方だけを見て「確定額」と読める表示が存在しない |
| C4 | **dynamic agent の消費が、恒久的な employee identity 無しに集計できる。** roster 未実装でも cost 集計が成立する |
| C5 | **budget の判断が、policy（version付き）+ evidence から再現できる。** 同じ入力から同じ判断が導けない状態を作らない |
| C6 | **cost の閾値超過が、保護対象の支出の**前**で承認要求または停止へ到達できる。** 事後通知しかできない設計にしない |
| C7 | **business value の推定が、方法論 / evidence / 確度を保持したまま流通する。** 推定が観測の顔をして集計に混ざらない |
| C8 | **Management Console が Task / Workflow / Department / Role / Provider / Model の各軸を比較できる。** かつ **Quest は enforcement を一切所有しない** |
| C9 | **provider 請求が遅延・欠落しても、fail-safe な既定挙動が policy から決まる。** 「消費0」として黙って続行しない |
| C10 | **ROI の報告に benefit-cost ratio / net ROI の別が明記される。** 曖昧な「N倍」表記が残らない |

---

## 11. 非目標 / 明示的に延期するもの

**本タスクで行わないこと**（実施済みの確認を含む）:

- runtime source の変更 / event・wire protocol の変更 / workflow・hook・permission・secret の変更
- 依存追加 / database・service・dashboard の実装 / budget enforcement の実装
- **provider 価格表の作成**（本タスクでも COST-0 でも作りません）
- 新規 branch の作成 / PR の作成・merge
- 無関係な refactor

**設計上、意図的に後回しにするもの**:

| 項目 | 理由 |
|------|------|
| 完全な cost dashboard | Management Console フェーズ。telemetry の信頼性が先 |
| 実際の budget 執行 | Policy / Approval / Stop 基盤が先（§9.3 COST-3） |
| ROI の自動算出 | baseline と方法論の定義が先（§9.3 VALUE-1） |
| 複数通貨の reporting 換算 | 原本保持（§4.2）さえ守れば後から足せる |
| 按分ルール（共有コストの配賦） | 帰属できない分を `unattributed` に留められる限り、急がない |
| 価格表の version 管理機構 | `pricing_source` に版を記録できれば、機構は後で足せる |
| provider 請求 API との突合 | COST-1 以降。今は `evidence_ref` の枠だけ |
| 予算の予測モデル | 単純な線形見込みで足りるかを COST-2 で観測してから決める |

**「将来使うか分からない複雑な機能」を先回りしません。**
今決めるのは §3 の envelope の次元と §4 の provider 独立性だけで、
これは**後から足すと過去データが全部無価値になる**ものに限定しています。

---

## 12. 確定した事実 と 未決事項

### 12.1 確定した事実（このrepositoryを読んで確認）

- 現行 wire 19 key / 内部 event model / `QuestState` のいずれにも
  usage・cost・token・price に相当する field は**存在しない**
- Quest runtime は GET のみ・`127.0.0.1` 固定・state 変更 endpoint なし
- 秘匿境界（raw prompt / secret / 絶対path を保存も配信もしない）は既に確立済み
- `hookWire.ts → hookAdapter.ts → validate.ts` の3段 adapter 構成が既に存在し、
  cost adapter の先例として使える
- `org-snapshot-design.md` §4.1 / §4.2（`company/org.yaml` の実在、照合key）は**未決のまま**

### 12.2 未決事項 / 未確認の仮定

| # | 項目 | 状態 |
|---|------|------|
| 1 | **前 run の `docs/loop-control-plane-design.md` の実内容** | 本 run では読めていません（§0.1）。本文書は題目参照に留めており、番号の食い違いは起きませんが、**本体側と重複する記述がある可能性**は残ります |
| 2 | provider 側 usage/billing の取得経路 | このrepositoryからは観測不能。COST-1 の前提 |
| 3 | 顧客 / project / 部署の識別子体系 | Company Brain 側の事実。`org-snapshot-design.md` §4.1 と同根 |
| 4 | 人件費単価・粗利率等、価値換算に使う業務前提 | owner の決定事項。VALUE-1 の前提 |
| 5 | budget period の実際の運用単位（月次固定か） | owner の決定事項。§6.2 で固定していません |
| 6 | `docs/automation-protocol.md` の不在 | 前 run が報告した escalation。本 run でも `docs/` に**存在しないことを確認**（`event-contract.md` / `live-wire-contract.md` / `org-snapshot-design.md` のみ） |

---

## 13. この文書の対象外

- Cost Governance / ROI の**実装**（telemetry、集計、enforcement、dashboard）
- 価格表、換算率、単価といった**具体的な数値**
- wire schema、API、SSE event、runtime 挙動の変更
- workflow、permissions、hooks、settings、Secrets、依存追加
- 外部 repository / 外部 service への接続
