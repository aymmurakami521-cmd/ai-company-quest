# 時間単価と `time_value_proxy` — 実装記録

**`docs/cost-governance-roi-design.md` の Business Value contract（§7）と ROI 用語（§8）を
実装したもの**です。別系統の ROI モデルは作っていません。設計文書が意図の正本で、
この文書と `src/` が **その enforcement** です。食い違った場合は常に実装（`src/`）が正です。

関連: [cost-governance-roi-design.md](cost-governance-roi-design.md)（value contract の正本） /
[org-snapshot-design.md](org-snapshot-design.md)（operator 入力の先例） /
[loop-control-plane-design.md](loop-control-plane-design.md)

---

## 1. 何を実装したか

| 層 | file |
|----|------|
| 時間単価 policy / resolver（pure） | `src/domain/rate.ts` |
| Value Evidence contract と `time_value_proxy` 導出（pure） | `src/domain/value.ts` |
| AI Cost / ARK fee の reporting bucket（pure） | `src/domain/costBucket.ts` |
| FX policy と換算（pure） | `src/domain/fx.ts` |
| benefit-cost ratio / net ROI（pure） | `src/domain/ratio.ts` |
| 比率・換算率のための exact decimal（pure） | `src/domain/decimal.ts` |
| 台帳 document の validator（pure） | `src/domain/valueLedger.ts` |
| ROI read model と開示 gate（pure） | `src/domain/valueDashboard.ts` |
| 台帳の読み込み（唯一の I/O） | `src/collector/valueLedgerLoader.ts` |
| 公開 route `GET /value/summary` | `src/server/server.ts` |
| 画面（ROI panel） | `src/ui/public/quest-value.js` |

**wire protocol・event contract・SSE frame・reducer state はいずれも変更していません。**
金額は event stream に一切載りません（→ §6）。

## 2. 時間単価の解決

解決順序は **固定**で、設定できません。

```
User > Department > Company > ARK default
```

- 各 scope は `effective_from` 付きで履歴を持ちます。ある時点で**在効な最新の1件**が勝ちます。
- 同一 scope・**同一 instant** の entry が2件あると「その時点で在効な1件」が定まらないため、
  validator が `duplicate_id` で**拒否**します。同一性はテキストではなく**解決した時刻**で見ます
  （`2026-08-01T00:00:00Z` と `2026-08-01T09:00:00+09:00` は同じ instant です）。
  テキストで比べると両方が通り、どちらが勝つかが **JSON 配列の並び順**で決まってしまいます。
  これは FX レート（§10.3）でも同じです。
- 同一 scope に entry が無い（またはその時点でまだ発効していない）場合のみ、次の scope へ落ちます。
- どの scope にも無ければ **ARK default = 3,400 JPY/hour**。
  これは **fallback proxy** であって、給与でも顧客単価でもありません。
  そのことを型で表すため basis は `employee_cost` / `time_value` ではなく
  `fallback_proxy`、input method は `ark_default` を持ち、
  **operator がこの2値を名乗ることは validator が拒否**します。
- 解決結果は `resolved_source`（`user` / `department` / `company` / `ark_default`）で
  必ず確認できます。

**落ちない条件**（fail-closed）:

| 条件 | 結果 |
|------|------|
| 呼び出し側が currency を指定し、解決した単価がそれと異なる | `unavailable / currency_mismatch`。**次の scope へ落としません**（別人の単価にすり替わるため） |
| ARK default に対し JPY 以外を期待 | `unavailable / currency_mismatch`。黙って換算しません（§4.2） |
| `at` が ISO-8601 として解釈できない | `unavailable / invalid_request`。「今」に読み替えません |

**欠損は 0 円になりません。** 解決できなければ value record を作らず、
read model の `unavailable` に理由付きで別掲します。

## 3. 入力方式

金額はすべて **その通貨の minor unit の整数**です（JPY は exponent 0 なので 3,400 = ¥3,400）。
float で持つと同じ入力が環境ごとに末尾桁で食い違うため、通貨計算は整数のみで行います。

| 方式 | 入力 | 意味 |
|------|------|------|
| `direct` | `hourly_rate_minor` / `currency` / `basis` | 単価を直接入れる |
| `calculated_monthly_cost` | `monthly_employer_cost_minor` / `monthly_working_hours` | `hourly_rate = 会社負担人件費 ÷ 月間労働時間`（half-up で minor unit へ丸め） |

- **個人の給与そのものの入力を求めません。** 入力するのは**会社負担人件費**で、
  法定事業主負担等を含めるかは入力側が決めます。給与の生データは保存しません。
- **算出に使った月額そのものも保持しません。** 受理後に残るのは時間単価と
  `input_method` だけです。月額は時間単価より機微な数字であり、
  それを読む利用者がいない以上、プロセス内に残す理由がありません。
- **Owner / 個人事業主**は `basis: time_value`（機会費用）で入れます。
  `employee_cost` と `time_value` は**別の値**として保持し、統合しません。
- 2つの方式を1 entry に混ぜると **拒否**します（片方だけ採用して黙って続行しません）。
- `0` 以下・非整数・NaN・Infinity・ISO 4217 でない currency は**すべて拒否**します。
  丸めた結果が 0 になる計算単価も拒否します（0 は以後の推定を静かに全部 0 にするため）。

## 4. `time_value_proxy`

```
time_value_proxy = time_saved × resolved_hourly_rate
```

- **常に `estimated`。** 型表（`VALUE_METRIC_RULES`）が `realized` を許しません。
  元の `time_saved` が `realized` でも、導出される金額は `estimated` です。
- **`realized_cost_saving` へ昇格しません。** 小計の key は `realization_status` と通貨の組で、
  両者が同じ合計に入る経路がありません。
- **元 record を書き換えず、別 record を作ります**（§7.1.1）。
  非金額の観測（分）と金額の推定は別々に監査できます。
- 日本語ラベルは **「創出時間価値（推定）」**。`実現削減額` とは別行・別小計です。

### 過去の値を後日の rate 変更で再計算しない

2段構えです。

1. **単価は record 自身の `measurement_window.end` 時点で解決**します。
   後から追加された（`effective_from` がその後の）entry は、何度実行しても勝てません。
2. 導出時に **実際に使った単価を `rate_evidence` として record に焼き込み**ます。
   台帳に既に proxy がある観測は **carry forward され、再計算されません**。
   期間を遡って backdate した rate でも、既存の値は変わりません。

`rate_evidence` が持つもの:
`resolved_source`（どの scope が勝ったか） / `entry_source`（その entry を誰が入れたか。
ARK default は誰も入れていないので `null`） / `scope` / `scope_id` / `hourly_rate_minor` /
`currency` / `basis` / `input_method` / `effective_from` / `effective_to` /
`resolved_at` / `policy_version`。

**台帳に既にある proxy は、その evidence と整合していなければ受理しません。**
参照先が `time_saved` であること、測定期間と帰属範囲が一致すること、
金額が `rate_evidence` の単価から実際に導かれる値であることを検査します。
これを省くと「もう算出済み」という保護が、誰も算出していない数字まで守ってしまいます。

**解決先の通貨は台帳の `reporting_currency` に一致しなければなりません。**
一致しない場合は fallback へ落とさず `unavailable / rate_currency_mismatch` とします。
落としてしまうと、運用者が選んでいない通貨の小計が「その会社の金額」として流通します。

## 5. 台帳 document

`QUEST_VALUE_LEDGER_PATH` で指定する **operator 入力の JSON** です。
`company/org.snapshot.json` と同じ扱い（設定由来のみ・起動時に1回・全件受理か全件拒否）。

```jsonc
{
  "schema_version": 1,
  "policy_version": "2026-08",
  "company_id": "acme",
  "reporting_currency": "JPY",
  // 省略時は "currency_partition"（mode A）。§7 参照
  "aggregation_mode": "reporting_currency_normalized",
  // mode B のときだけ参照する。省略可（単一通貨なら不要）。§10 参照
  "fx_rates": [
    { "from_currency": "USD", "to_currency": "JPY",
      "effective_from": "2026-01-01T00:00:00Z",
      "from_amount_minor": 10000, "to_amount_minor": 14825,
      "fx_source": "published_reference", "fx_rate_version": "2026-08" }
  ],
  "hourly_rates": [
    { "scope": "company", "scope_id": "acme", "effective_from": "2026-01-01T00:00:00Z",
      "currency": "JPY", "basis": "employee_cost",
      "input_method": "calculated_monthly_cost",
      "monthly_employer_cost_minor": 640000, "monthly_working_hours": 160,
      "source": "operator" },
    { "scope": "user", "scope_id": "owner", "effective_from": "2026-01-01T00:00:00Z",
      "currency": "JPY", "basis": "time_value",
      "input_method": "direct", "hourly_rate_minor": 12000, "source": "operator" }
  ],
  "value_records": [
    { "record_id": "ts-1", "value_metric_type": "time_saved",
      "value_kind": "non_monetary", "realization_status": "estimated",
      "unit": "minute", "quantity": 120,
      "baseline": { "kind": "manual_process_measurement", "quantity": 180 },
      "measurement_window": { "start": "2026-05-01T00:00:00Z", "end": "2026-05-31T23:59:59Z" },
      "attribution_scope": { "company_id": "acme", "department_id": null, "user_id": "owner" },
      "attribution_method": "operator_declared", "confidence": "medium",
      "methodology_version": "v1", "evidence_ref": null,
      "derived_from": null, "rate_evidence": null }
  ],
  "ai_cost": { "cost_status": "finalized", "amount_minor": 42000, "currency": "JPY",
               "pricing_source": "provider_invoice", "pricing_version": "2026-08",
               // 省略可。比率を出すには必須（§11）
               "period": { "start": "2026-08-01T00:00:00Z", "end": "2026-08-31T23:59:59Z" } },
  "ark_fee": null
}
```

`aggregation_mode` / `fx_rates` / `ai_cost.period` は**すべて省略可能**です。
省略した document の挙動は追加前と1 byte も変わりません（`schema_version` は 1 のまま）。

- 未知 key は **drop** し、下流へ渡しません。
- すべての文字列は event path と同じ `scanUnsafe` を通ります（絶対 path・credential 形状は拒否）。
- **拒否理由は field path と rule 名のみ**です。値は一切返しません。
  台帳には金額が入っているため、validation error が開示にならないようにしています。
  読み取り自体に失敗した場合は `unreadable`、読めたが JSON でなかった場合は `not_object` と
  **別の rule** にしています。path の打ち間違いと壊れた台帳が同じ起動ログになると切り分けができません。
- `cost_status` の cross-field 不変条件（§3.6）を守ります。
  **`unpriced` は 0 円ではありません**。確定した 0 円は `finalized` + `amount_minor: 0` です。

## 6. 安全境界 — なぜ書込 UI を作っていないか

**Quest は read model で、認証も identity も持ちません。** GET しか答えず、
POST / PUT / DELETE は 405 を返します。ここに Owner/Admin 用の単価編集画面を足すと、
このプロセス初の **認証付き mutating endpoint** を、認証基盤が無い場所に作ることになります。
本体設計が定めた経路は
`Quest / Management UI → authenticated Control API → Policy/Approval Gate → Executor`
だけであり、それを飛ばすことはしません。

したがって本 PR の実装境界は次のとおりです。

| 実装した | follow-up |
|----------|-----------|
| domain / schema / resolver / effective・history / evidence snapshot / read model / dashboard 表示 | **単価と value record の write surface（Owner/Admin 編集 UI と Control API）** |
| operator 設定 file を唯一の入力面とする | authenticated な role 判定（Owner / Admin / 一般 User の区別） |

**金額が read-only stream へ漏れないこと**は次で担保しています。

- `QuestState` に rate も value も**入れていません**。SSE の `snapshot` frame は
  `QuestState` そのものなので、stream から金額は観測できません（test で固定）。
- 金額は `GET /value/summary` だけが返し、その内容は**起動時に1回**組み立てられます。
  request の query や header は開示レベルを**一切変えられません**。
- 既定は `QUEST_VALUE_DISCLOSURE=restricted`。
  この状態では**すべての金額 key が payload から欠落**し、`amount_withheld: true` が付きます。
  **0 を返しません**（0 は「価値が無かった」という別の主張になるため）。
  件数・通貨・`resolved_source`・適用期間は残るので、「無い」と「見せていない」は区別できます。
- 一般 User への金額表示制限は、この開示レベルで実現しています。
  役割ごとの出し分けは、認証境界が入る follow-up の範囲です。

## 7. 集計の規則

- 小計の key は **`realization_status` × 通貨**。mode A では原通貨、mode B では報告通貨です。
  **どちらの mode でも `realization_status` は独立軸のまま**で、推定と実現は同じ小計に入りません。
- `non_monetary`（分・件）は金額小計に入りません。単位ごとに別掲します。
- **総合計（grand total）を作りません。** 推定が実現の顔をする経路を構造的に断つためです。
- AI 関連コストと ARK 利用料は value と別 section で、それぞれ `cost_status` を保持します。
- 採用した mode は `aggregation_mode` として payload に必ず載せ、画面にも併記します（§8.5）。

| mode | `aggregation_mode` | 換算 | 既定 |
|------|--------------------|------|------|
| A. 通貨別 partition | `currency_partition` | しない | ✅ |
| B. 報告通貨へ正規化 | `reporting_currency_normalized` | する（§10） | |

## 8. 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `QUEST_VALUE_LEDGER_PATH` | なし | 台帳 JSON の path。未設定は `absent`（正常な運用形態） |
| `QUEST_VALUE_DISCLOSURE` | `restricted` | `restricted` / `full`。未知の値は**起動時に fail closed** |

`npm run demo` / `npm run demo:static` で台帳未設定の場合のみ、
`src/demo/valueFixture.ts` の固定データを使います。その場合 payload は
`ledger_source: "demo_fixture"` を返し、画面も「デモ用の固定データ（実データではありません）」
と明示します。**架空の金額が自社の数字として読まれることはありません。**

## 10. FX 換算（mode B）

### 10.1 レートの入力面 — 外部依存を作っていない

**換算率は運用者が台帳 document に書いたものだけ**です。`src/domain/fx.ts` は
network client も filesystem handle も clock も持たず、import しているのは同じ
`src/domain/` の隣接 module だけです（`test/value-fx.test.ts` が**構造として**固定しています）。

「今日のレートを取りに行く」経路は**意図的に作っていません**。取得時刻が記録されない
network call から来た数字は、§7.3.1 が mode B に義務づける
**出所と適用時点**を満たせません。read-only の local 画面が外部サービスに依存することにもなります。

### 10.2 レートの書き方 — minor unit 同士の厳密な有理数

```jsonc
{ "from_currency": "USD", "to_currency": "JPY",
  "from_amount_minor": 10000, "to_amount_minor": 14825,   // $100.00 = ¥14,825
  "effective_from": "2026-01-01T00:00:00Z",
  "fx_source": "published_reference", "fx_rate_version": "2026-08" }
```

小数のレート（"148.25 JPY/USD"）ではなく**2つの minor unit 金額**にしている理由は2つです。

- **exponent 表を計算に入れない。** `MINOR_UNIT_EXPONENTS` は *表示* 用の表で、
  未登録の通貨には 2 を返します。小数のレートを minor unit に適用するには両通貨の
  exponent が要り、fallback が外れれば金額が黙って 100 倍ずれます。
  両辺を minor unit で書けばその推測自体が消えます。
- **レートが厳密。** 小数を parse しないので、換算前に丸めが起きません。
  丸めは換算の1回だけです（`bigint` で乗算してから除算・half away from zero）。

`fx_source` は閉じた語彙（`operator_declared` / `contract_rate` / `published_reference`）で、
**どれも live service を指しません**。すべて「運用者が document に転記した」行為の分類です。

### 10.3 落ちない条件（fail-closed）

| 条件 | 結果 |
|------|------|
| その通貨ペアの適用可能なレートが無い | `fx_unconverted` に理由付きで別掲。**0 円にしない** |
| **逆方向**（`USD→JPY` しか無いのに `JPY→USD` を要求） | 同上。逆数は別のレートであり、勝手には作りません |
| **三角換算**（`USD→JPY` と `JPY→EUR` から `USD→EUR`） | 同上。合成した丸めには出所も適用時点もありません |
| record の期間より後にしか発効していないレート | 適用しません（§10.4） |
| 換算結果が金額上限を超える | 同上。clamp しません |
| `from === to` の entry | validator が**拒否**。換算していないものを換算したと記録しないため |
| 同一 pair・**同一 instant** の entry が2件 | validator が `duplicate_id` で**拒否**。同一性は解決した時刻で見るので、offset 違い（`…T00:00:00Z` と `…T09:00:00+09:00`）や小数秒違いも1つの instant です。並び順で勝敗を決めません |

**換算できなかった金額があると、その小計は「converted 分だけの合計」を publish しません。**
`total_blocked` を立てて **total 自体を出しません**。converted 分だけを出すと、
読み手に分からない形で小さくなった合計が流通します。§7.3.1 が
「その小計の算出を失敗させて理由を記録する」と定めているのはこの状態です。
個々の record は破棄せず、`fx_unconverted` で1件ずつ名指しします。

### 10.4 過去の値を後日のレートで再計算しない

**レートは record 自身の `measurement_window.end` 時点で解決**します（cost bucket は
`period.end`）。後から追加された（`effective_from` がその後の）レートは、何度実行しても勝てません。
`resolved_at` に相当する `fx_effective_at` と、適用期間（`fx_effective_from` /
`fx_effective_to`）を evidence に載せるので、どのレートがどの期間に効いたかを後から追えます。

期間の無い cost bucket は**換算できません**。換算には基準時点が要り、「今」や
「value record が張る期間」で代用すると、画面を開いた時刻で適用レートが変わります。

### 10.5 evidence として残すもの（§7.3.1 の必須項目）

換算した record ごとに `fx_trace` の1行として publish します。

`record_id` / `from_currency` → `to_currency` / `fx_from_amount_minor` /
`fx_to_amount_minor` / `fx_rate`（6桁固定小数の文字列）/ `fx_source` /
`fx_rate_version` / `fx_effective_from` / `fx_effective_to` / `fx_effective_at` /
**原本の金額**（`original_amount_minor`）と換算後（`converted_amount_minor`）。

原本は上書きしません（§4.2）。cost bucket も同じで、`costs.ai_cost.fx` に
原通貨と原本金額を残したまま報告通貨の金額を出します。

`restricted` では**金額2つ（原本・換算後）だけを伏せ**、レートと出所と期間は残します。
レートは「その会社の金額」ではなく、伏せると監査ができなくなるためです。
`fx_from_amount_minor` / `fx_to_amount_minor` に `fx_` を付けているのは、
**これがレートの辺であって誰かの金額ではない**ことを、読み手にも grep にも示すためです。

### 10.6 mode B で時間単価の通貨制約が動く理由

mode A では、解決した時間単価の通貨が `reporting_currency` と違えば
`unavailable / rate_currency_mismatch` です（§4 末尾・維持）。

mode B ではこの制約が**消えるのではなく移動**します。単価は自分の通貨で解決してよく、
FX 層が報告通貨へ持ってきます — **運用者が与えた・日付の付いた・evidence に残るレート**で。
換算路が無ければ推定は publish されず、`fx_unconverted` に載ります。
どちらの mode でも「運用者が選んでいない通貨の小計」は出ません。

---

## 11. benefit-cost ratio / net ROI（比率層）

用語と前提は `cost-governance-roi-design.md` §8 の正本どおりです。

```
benefit-cost ratio = business_value / ai_cost
net ROI            = (business_value - ai_cost) / ai_cost = benefit-cost ratio - 1
```

`net_roi` は**丸めた benefit-cost ratio から 1 を引いて**求めます。2回目の丸めをしないので、
publish された2つの数字が互いに矛盾しません。どちらも **6桁固定小数の文字列**です
（`decimal.ts`：full ledger の小計を最小コストで割ると double の精度を超えるため、
JSON number にすると答えが黙って丸まります）。

### 11.1 分母が 0 / 欠損のとき — silent zero にしない

比率が出せないときは **0 も ∞ も「—」も出しません**。理由を持つ閉じた語彙
`ratio_status` を返します。

| `ratio_status` | 意味 |
|----------------|------|
| `computed` | §8.2 の前提をすべて満たし、算出した |
| `undefined_zero_denominator` | AI コストが**既知の 0**（`finalized`/`estimated` で amount = 0）。既知だが数学的に未定義 |
| `blocked_unpriced_cost` | AI コストが `unpriced`（金額未確定）。**0 ではなく不明** |
| `blocked_unresolved_cost` | §3.5 の未解決消費。**この build では到達しません**（provider telemetry が無い）。語彙は先に確保 |
| `blocked_non_monetary_operand` | その realization_status の value が非金額（分・件）しか無い |
| `blocked_currency_mismatch` | 通貨が揃わない／mode B で分子の一部が換算できていない（§10.3） |
| `blocked_scope_mismatch` | cost の期間が無い、または期間が record の測定期間と噛み合わない |
| `blocked_methodology_mismatch` | 分子の `methodology_version` が揃っていない |
| **`blocked_absent_value`**（追加） | その realization_status の金額記録が**そもそも無い**。0 ではなく不在 |
| **`blocked_absent_cost`**（追加） | `ai_cost` bucket が**報告されていない**。`unpriced` とは別の事実（§3.6） |

下2つは §8.4 の表への**追加**です。既存 8 個は削除も意味変更もしていません。
§8.4 の表は分子の存在を前提に分母側の失敗だけを並べているため、
「実現した金額の記録が無い」を表す語がありませんでした。無いまま実装すると
0 倍と表示することになり、それは §8.4 が唯一禁じていることです。

### 11.2 estimated と realized を混ぜない

**行は `realization_status` ごと**で、分子はその status の金額記録だけです。
`time_value_proxy` は契約上 `estimated`、`realized_cost_saving` は契約上 `realized` なので、
**2つを足して1本の比率にする経路はコード上存在しません**（分子を作る前に status で分けています）。
分母側の `estimated` / `finalized` は各行に `cost_status` として併記します（§8.3）。

日本語 UI でも「費用対効果比 benefit-cost ratio」「純ROI net ROI」を**用語名ごと**出し、
行には 実現 / 推定 のラベルが付きます。1つの無印の比率は作りません。

### 11.3 期間と範囲（§8.2）

- **範囲**は構造的に一意です。validator が `attribution_scope.company_id` の異なる record を
  拒否するので、ここで出る比率は常に**会社スコープ**の比率です。
  部署別・個人別の比率は、スコープ付きの cost が要るため対象外です。
- **期間**は cost bucket の `period` を運用者が書いた場合にだけ成立します。
  - 測定期間が `period` に**含まれる** record が分子に入ります。
  - 完全に外の record は別期間のものなので `excluded_record_count` として**見える形で**除外します。
  - **境界をまたぐ** record は期間が噛み合っていないので、切り取らずに `blocked_scope_mismatch` にします。
  - `period` が無ければ `blocked_scope_mismatch`。「value record が張る期間だろう」という
    暗黙の仮定を置きません。
- **methodology** は分子内で `methodology_version` が一致していることを要求します。
  `attribution_method` の一致は要求しません — 導出された `time_value_proxy` は必ず
  `derived_from_time_saved` を持つため、一致を要求すると推定側の比率が永久に blocked になり、
  読み手には何の情報も伝わりません。

### 11.4 分母は AI 関連コストだけ

§8.1 の定義どおり `business_value / ai_cost` で、**ARK 利用料は分母に入れていません**。
入れると同じ名前で別の比率を publish することになります。

### 11.5 開示

`restricted` では **`ratio_status` は残し、比率と両オペランドを伏せます**
（`amount_withheld: true`）。比率自体は無次元でどちらのオペランドも復元できませんが、
金額から導いた数字であることに変わりはなく、この read model の既定は
そういう数字をすべて伏せる側です。役割ごとに見せ方を変えるのは identity を要する
follow-up（§6）の範囲です。

**既知の限界**: `restricted` でも `undefined_zero_denominator` は出るので、
「AI 関連コストが 0 である」ことは読み取れます。ここを伏せると
§8.4 が要求する「理由を人間に提示する」が成立しないため、意図的に残しています。

---

## 12. この文書の対象外

- ARK の請求・決済、billing 実装
- HR / 給与システム連携、個人給与の取得
- Provider AI usage Cost の telemetry（`cost-governance-roi-design.md` §9.3 の後続）
- 役割別の金額出し分け（identity / 認証基盤を要する。§6 の follow-up）
- 外部サービスからの FX レート取得（§10.1 のとおり**作りません**）
- payback period の算出
