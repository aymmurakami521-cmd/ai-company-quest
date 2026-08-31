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
               "pricing_source": "provider_invoice", "pricing_version": "2026-08" },
  "ark_fee": null
}
```

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

- 小計の key は **`realization_status` × 通貨**（§7.3.1 mode A・通貨別 partition）。
  FX 換算は**行いません**。通貨をまたぐ合計は payload のどこにも存在しません。
- `non_monetary`（分・件）は金額小計に入りません。単位ごとに別掲します。
- **総合計（grand total）を作りません。** 推定が実現の顔をする経路を構造的に断つためです。
- AI 関連コストと ARK 利用料は value と別 section で、それぞれ `cost_status` を保持します。

## 8. 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `QUEST_VALUE_LEDGER_PATH` | なし | 台帳 JSON の path。未設定は `absent`（正常な運用形態） |
| `QUEST_VALUE_DISCLOSURE` | `restricted` | `restricted` / `full`。未知の値は**起動時に fail closed** |

`npm run demo` / `npm run demo:static` で台帳未設定の場合のみ、
`src/demo/valueFixture.ts` の固定データを使います。その場合 payload は
`ledger_source: "demo_fixture"` を返し、画面も「デモ用の固定データ（実データではありません）」
と明示します。**架空の金額が自社の数字として読まれることはありません。**

## 9. この文書の対象外

- ARK の請求・決済、billing 実装
- HR / 給与システム連携、個人給与の取得
- Provider AI usage Cost の telemetry（`cost-governance-roi-design.md` §9.3 の後続）
- FX 換算、reporting 通貨への正規化（mode B）
- benefit-cost ratio / net ROI の自動算出（`ratio_status` を含む §8 の比率層）
