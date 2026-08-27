# Run / Event Contract v1（LCP-1）

Loop Control Plane が所有する **run と遷移の machine-readable 契約**です。
**この文書はコードを変更しません。** 新しい wire schema、API、SSE frame、runtime 挙動、
環境変数、依存のいずれも追加・変更しません。

決めるのは **閉じた語彙と、その語彙にかかる deterministic な不変条件**だけです。
実 field 名の物理表現（JSON key の綴り、型の実装、DOM 構造）は、対応する実装 PR で決めます。

実装とこの文書が食い違った場合は、常に **実装（`src/`）が正**です。

関連: [loop-control-plane-design.md](loop-control-plane-design.md)（本体設計） /
[cost-governance-roi-design.md](cost-governance-roi-design.md)（cost 追補） /
[event-contract.md](event-contract.md) / [live-wire-contract.md](live-wire-contract.md) /
[role-binding-registry.md](role-binding-registry.md)（provider 名の唯一の権威 source）

**この文書の言語**: 日本語散文 + 英語識別子（本体設計 Communication / language policy）。

---

## 目次

| § | 内容 |
|---|------|
| [0](#0-この文書の位置づけ) | この文書の位置づけ |
| [1](#1-契約の識別と互換-gate) | 契約の識別と互換 gate |
| [2](#2-run-event-の共通-envelope-と相関-field) | Run event の共通 envelope と相関 field |
| [3](#3-state-code-v1閉じた語彙) | State code v1（閉じた語彙） |
| [4](#4-遷移-guard決定論) | 遷移 guard（決定論） |
| [5](#5-event-code-v1閉じた語彙) | Event code v1（閉じた語彙） |
| [6](#6-event-code-命名規則provider-中立) | Event code 命名規則（provider 中立） |
| [7](#7-evidence-kind-v1閉じた語彙) | Evidence kind v1（閉じた語彙） |
| [8](#8-failure-type-v1閉じた語彙) | Failure type v1（閉じた語彙） |
| [9](#9-cost-0-usage--cost-attribution-envelopeadditive--optional) | COST-0 usage / cost attribution envelope（additive / optional） |
| [10](#10-provider-中立検査との関係) | provider 中立検査との関係 |
| [11](#11-用語と不変条件の突き合わせreconciliation) | 用語と不変条件の突き合わせ（reconciliation） |
| [12](#12-この文書の対象外) | この文書の対象外 |
| [13](#13-未決事項) | 未決事項 |

---

## 0. この文書の位置づけ

### 0.1 何を確定するか

本体設計は state code / event code / evidence kind / 失敗種別の一覧を
「LCP-1 の範囲」として明示的に先送りしていました。本文書がその 4 つを確定します。
併せて cost 追補が LCP-1 への **additive / optional な追記**として指定した
usage / cost attribution envelope の次元・必須性・cross-field invariant を確定します。

| 確定するもの | 由来 |
|---|---|
| State code v1（§3） | 本体設計 Run State Machine v1 の状態表 |
| 遷移 guard の正規化（§4） | 本体設計 遷移の規則 |
| Event code v1（§5） | 本体設計 Event schema の原則 / event family（概念例）を閉じた一覧へ確定 |
| Event code 命名規則（§6） | 本体設計 Provider Adapter 境界 / cost 追補 §4.1 |
| Evidence kind v1（§7） | 本体設計 Evidence Bundle |
| Failure type v1（§8） | 本体設計 Retry / stall / heartbeat / idempotency |
| usage / cost attribution envelope（§9） | cost 追補 §3.1〜§3.6・§4.1（COST-0） |

### 0.2 3 つの契約を混同しない

このリポジトリには **契約が 3 本**あり、いずれも別物です。名前が似ているだけで
互換ではありません。既存の [event-contract.md](event-contract.md) が
「これは外部 wire 契約ではありません」と宣言しているのと同じ趣旨の宣言を、ここでも置きます。

| 契約 | 対象 | 正本 |
|---|---|---|
| 外部 LIVE wire 契約 | 外部 hook 入力の rich / nested 形式 | [live-wire-contract.md](live-wire-contract.md) と adapter 実装 |
| 内部 normalized event model（`schema_version = 2`） | reducer / store / SSE / 画面 / DEMO fixture が共有する既存の flat な形式 | [event-contract.md](event-contract.md) と `src/domain/event.ts` / `src/domain/validate.ts` |
| **Run / Event contract v1（本文書）** | Loop Control Plane の run と遷移 | 本文書（実装は未着手） |

- **本文書は既存 2 契約に key を足しません。** 既存の wire key 集合
  （`src/domain/wire.ts` の `WIRE_EVENT_KEYS`）にも、
  [event-contract.md](event-contract.md) の Keys 表にも、本文書の語彙は追加されません。
- Quest が run event を受ける場合、本体設計のとおり **独立した namespace** の
  read model として受けます。既存 LIVE / DEMO の store と state・seq・dedupe・
  replay buffer・subscriber を共有しません。
- **本文書に対応する runtime は現時点で存在しません。** 供給元は後続の
  権威 run source（本体設計 STORE-1）であり、それより先に production の
  read model を出しません。

### 0.3 分類

**A（docs / 契約のみ）。** runtime 影響なし、依存追加なし、workflow 変更なし。

---

## 1. 契約の識別と互換 gate

| 規則 | 内容 |
|---|---|
| R1-1 | 本契約の識別子は `run_event_contract_version`。v1 の値は `1` |
| R1-2 | **互換 gate は `run_event_contract_version` のみ**。既知の値以外は fail closed で拒否する |
| R1-3 | 既存の内部 event model の `schema_version` と**同じ field ではありません**。両者を同一の値空間として扱いません |
| R1-4 | 語彙（state code / event code / evidence kind / failure type）の**要素追加は minor**、**要素の削除・意味変更は major** とし、major は新しい `run_event_contract_version` を要する |
| R1-5 | `sanitizer_version` に相当する観測情報を持つ場合、それは**受理判定に使いません**（既存契約と同じ作法） |
| R1-6 | 必須 key は **常に全て存在**します。値が無い場合は明示的な `null` で、key 欠落は拒否です |
| R1-7 | **未知の key は検証時に drop** し、外へ出しません |
| R1-8 | 語彙値は `[A-Z][A-Z0-9_]*`（英語 UPPER_SNAKE）。表示用の日本語 label は別途 mapping し、**未知の code は表示しません** |

---

## 2. Run event の共通 envelope と相関 field

すべての run event が持つ共通部です。**1 event = 1 事実**であり、派生値・集計値を持ちません。
state は event の fold であって、event の field ではありません。

| field | 必須 | 内容 |
|---|---|---|
| `run_event_contract_version` | **必須** | `1`。互換 gate（R1-2） |
| `event_id` | **必須** | 重複排除に使う安定した識別子 |
| `event_code` | **必須** | §5 の閉じた語彙 |
| `occurred_at` | **必須** | 事実が発生した時刻（ISO-8601） |
| `recorded_at` | **必須** | Store が記録した時刻（ISO-8601）。`occurred_at` と**別 field** |
| `goal_id` | **必須** | 相関 field |
| `run_id` | **必須** | 相関 field |
| `attempt_id` | **必須**（値は `null` 可） | 相関 field。run 単位の事実では `null` |
| `role` | **必須**（値は `null` 可） | 論理 role code。controller 自身の事実では `null`。**推測しません** |
| `causation_id` | **必須**（値は `null` 可） | 直接の原因 event |
| `correlation_id` | **必須**（値は `null` 可） | 一連の処理の相関 |
| `payload` | **必須** | event_code ごとに定まる closed な内容。自由記述を置きません |

### 2.1 規則

| 規則 | 内容 |
|---|---|
| R2-1 | **append-only / immutable。** 訂正は上書きではなく**補償 event の追加**で表します |
| R2-2 | **順序は受信側が採番**します。producer 由来の seq を持つ場合、それは診断用で順序判定に使いません |
| R2-3 | **provider 固有情報を core event の field へ昇格させません。** provider 情報は §9 の dimension 値、または adapter 境界の内側にのみ置きます |
| R2-4 | **禁止内容 check を run event にも適用**します（絶対 path / credential / shell 断片）。拒否理由は **field 名 + rule 名のみ**で、内容文字列を含めません |
| R2-5 | `attempt_id` が非 `null` の event は、その `attempt_id` の `ATTEMPT_STARTED` より後でなければなりません |
| R2-6 | 同一 `event_id` の重複配信は 1 件として扱い、**遷移を二重適用しません** |

---

## 3. State code v1（閉じた語彙）

**これが v1 の全てです。** 一覧に無い状態は存在しません。

| state | 意味 | 終端 |
|---|---|---|
| `CREATED` | contract が確定し run が採番された | |
| `PLANNING` | `PLANNER` が計画を提案中 | |
| `PLAN_REVIEW` | 計画に対する review / policy check | |
| `BLOCKED_ON_INPUT` | owner への質問待ち。**時間経過では進みません** | |
| `EXECUTING` | `EXECUTOR` が作業中 | |
| `EVIDENCE_COLLECTING` | evidence を集めている | |
| `REVIEWING` | `REVIEWER` / `SECURITY_REVIEWER` の検証中 | |
| `RISK_ASSESSING` | diff が存在した後の risk 再評価 | |
| `AWAITING_APPROVAL` | protected action 前の owner 承認待ち | |
| `APPROVED` | 承認済み。`approved_head_sha` が紐づく | |
| `APPLYING` | protected action の実行中 | |
| `VERIFYING` | 適用後の観測 | |
| `SUCCEEDED` | success_criteria を満たして完了 | ✔ |
| `FAILED` | 失敗が確定し retry 予算も尽きた | ✔ |
| `STOPPED` | stop condition / kill switch により停止 | ✔ |
| `EXPIRED` | budget / timeout 超過 | ✔ |

### 3.1 状態語彙の規則

| 規則 | 内容 |
|---|---|
| R3-1 | **stall は状態ではありません。** 進行が観測できないことは遷移先ではなく観測事実なので、`RUN_STALLED`（§5）という **event code** で表します。stall が budget 超過に至れば `EXPIRED`、kill switch が引かれれば `STOPPED` へ遷移します |
| R3-2 | **終端は不可逆**です。終端状態から戻りません。やり直しは新しい run です |
| R3-3 | `SUCCEEDED` / `FAILED` / `STOPPED` / `EXPIRED` の 4 つだけが終端です |
| R3-4 | `run` は goal に対する 1 本の loop、`attempt` はその中の実行試行です。retry は **同じ contract・新しい `attempt_id`** で行い、run を作り直しません |

---

## 4. 遷移 guard（決定論）

| 規則 | 内容 |
|---|---|
| R4-1 **単一 writer** | 遷移を書けるのは controller のみ。agent は proposal を返すだけで、遷移を宣言できません |
| R4-2 **guard は deterministic** | 各遷移の guard は code で判定します。LLM の判断は guard の**入力**にはなりますが、guard そのものにはなりません |
| R4-3 **`APPLYING` の guard** | `evidence_bundle_complete == true` **かつ**（`risk_class ∈ {A, B}` **または**（`approval_present == true` **かつ** `approved_head_sha == observed_head_sha`）） |
| R4-4 **`approval_present` の定義** | **OWNER の `APPROVAL_RECORD` だけが `true` にできます。** role 由来の `REVIEW` / `SECURITY_REVIEW` / `RISK_ASSESSMENT` / `POLICY_CHECK` は evidence bundle には寄与しますが、`approval_present` を満たしません |
| R4-5 **evidence bundle の完全性** | contract の `required_evidence[]` の全 kind が `PASS` で揃って初めて `evidence_bundle_complete == true` です。`INCONCLUSIVE` は `PASS` ではありません（fail closed） |
| R4-6 **承認は時間で進まない** | `AWAITING_APPROVAL` から先へ進むには approval record が必要です。timeout は `EXPIRED` へ落とすだけで、承認したことにはしません |
| R4-7 **approval は SHA に紐づく** | `approved_head_sha` と観測 head が違えば approval は失効し、`AWAITING_APPROVAL` へ戻ります |
| R4-8 **risk 昇格は割り込む** | `RISK_ESCALATED` が起きたら、`APPLYING` に入る前に必ず `AWAITING_APPROVAL` を経由します |
| R4-9 **昇格は自動・降格は承認制** | risk の昇格は deterministic gate が自動で行えます。降格は **owner 承認が必要**で、agent は降格できません（monotonic escalation） |
| R4-10 **kill switch** | 任意の非終端状態から `STOPPED` へ遷移できます |
| R4-11 **再入は冪等** | 同じ transition が重複配信されても 2 回適用しません（R2-6） |

---

## 5. Event code v1（閉じた語彙）

**これが v1 の全てです。** 一覧に無い code は発行できません。
本体設計の event family は概念上の分類例でしたが、以下が確定した一覧です。

### 5.1 run lifecycle

| event_code | 事実 |
|---|---|
| `RUN_CREATED` | contract が確定し run が採番された |
| `RUN_STATE_CHANGED` | 状態が遷移した（`from` / `to` は §3 の語彙） |
| `RUN_STOPPED` | stop condition / kill switch により停止した |
| `RUN_STALLED` | `last_heartbeat_at + stall_threshold < now` を controller が判定した（R3-1） |
| `ATTEMPT_STARTED` | 新しい `attempt_id` の実行試行が始まった |
| `ATTEMPT_ENDED` | 実行試行が終わった（成否と §8 の `failure_type` を伴う） |

### 5.2 role 実行

| event_code | 事実 |
|---|---|
| `ROLE_INVOKED` | 論理 role の実行を開始した |
| `ROLE_COMPLETED` | 論理 role が output schema に従う proposal を返した |
| `ROLE_FAILED` | 論理 role の実行が失敗した（§8 の `failure_type` を伴う） |

### 5.3 evidence

| event_code | 事実 |
|---|---|
| `EVIDENCE_ATTACHED` | evidence が bundle に受理された |
| `EVIDENCE_REJECTED` | evidence が受理されなかった（理由は field 名 + rule 名のみ・R2-4） |
| `EVIDENCE_INVALIDATED` | 既存 evidence が失効した（head SHA が動いた等） |

### 5.4 risk

| event_code | 事実 |
|---|---|
| `RISK_CLASSIFIED` | risk class を判定した。**最低 2 回**発生します（計画確定後と、diff が存在した後） |
| `RISK_ESCALATED` | risk class が上がった |
| `RISK_DEESCALATED` | risk class が下がった。**owner 承認 evidence を伴わない発行は契約違反**です（R4-9） |

### 5.5 approval

| event_code | 事実 |
|---|---|
| `APPROVAL_REQUESTED` | protected action 前の承認を要求した |
| `APPROVAL_GRANTED` | OWNER が承認した（`approved_head_sha` を伴う） |
| `APPROVAL_DENIED` | OWNER が承認しなかった |
| `APPROVAL_INVALIDATED` | head が動く等により承認が失効した（R4-7） |

### 5.6 制御

| event_code | 事実 |
|---|---|
| `RETRY_SCHEDULED` | retry を予定した（§8 の retry 可否を満たす場合のみ） |
| `BUDGET_EXHAUSTED` | budget（attempts / wall clock / invocations / cost unit）が尽きた |
| `LEASE_ACQUIRED` | run の lease を取得した |
| `LEASE_LOST` | lease を失った。以後その実行主体の書き込みは拒否されます |
| `HEARTBEAT` | 実行中である旨の定期報告 |
| `STOP_REQUESTED` | kill switch が引かれた |

### 5.7 usage / cost（COST-0・additive）

| event_code | 事実 |
|---|---|
| `USAGE_RECORDED` | 1 件の消費事実を記録した。§9 の attribution envelope を `payload` に持ちます |
| `COST_ATTRIBUTION_CORRECTED` | 既存の消費 record を訂正した。**上書きではなく追加**です（R9-10） |

### 5.8 event 語彙の規則

| 規則 | 内容 |
|---|---|
| R5-1 | **状態遷移の正本は `RUN_STATE_CHANGED` のみ**です。他の code から状態を推測しません |
| R5-2 | `RISK_CLASSIFIED` は **`APPLYING` より前に必ず 1 回以上**、かつ diff 発生後に 1 回以上発生します |
| R5-3 | budget policy の閾値判定・警告・enforcement を表す code は **v1 に存在しません**（後続 COST-3 の範囲）。cost 事象は既存の approval / stop 機構へ写像し、**cost 専用の停止経路を新設しません** |
| R5-4 | §5.7 の 2 code は **optional** です。発行されないことは契約違反ではありません（§9.1） |

---

## 6. Event code 命名規則（provider 中立）

| 規則 | 内容 |
|---|---|
| R6-1 | `event_code` / state code / evidence kind / failure type は `[A-Z][A-Z0-9_]*` の閉じた語彙です |
| R6-2 | **これらの code に provider 名・vendor 名・brand 名・model 名・model family 名を含めません。** 禁止 token の権威 source は [role-binding-registry.md](role-binding-registry.md) ただ 1 つです |
| R6-3 | provider / model は **集計軸（dimension）の値**としてのみ現れます。code へ昇格させません |
| R6-4 | 従って、消費の記録は provider 非依存の `USAGE_RECORDED` に provider / model を**属性として**載せる形を取ります。provider 名を含む消費 code を作りません |
| R6-5 | **論理 role は provider から独立**です。`PLANNER` の provider が変わっても、`logical_role = PLANNER` の集計は連続します |
| R6-6 | adapter は core event を生成できますが、**core event に provider 固有 field を足せません**。adapter の出力は内部 validator へ再投入します |

---

## 7. Evidence kind v1（閉じた語彙）

Evidence は **controller が deterministic に検証できる観測結果への参照**です。
agent の主張ではありません。

### 7.1 Evidence の形

| field | 内容 |
|---|---|
| `evidence_id` | 安定した識別子 |
| `kind` | §7.2 / §7.3 の閉じた語彙 |
| `ref` | 観測対象への参照（URL / SHA / check id など）。**本文のコピーではありません** |
| `observed_at` | 観測時刻（ISO-8601） |
| `observer_role` | どの論理 role が観測したか |
| `digest` | 参照先の同一性を確認するための要約値 |
| `verdict` | `PASS` / `FAIL` / `INCONCLUSIVE` の閉じた語彙 |

### 7.2 core kind

| kind | 内容 |
|---|---|
| `HEAD_SHA` | 対象の head SHA |
| `DIFF_SCOPE` | 変更された path 集合が `allowed_paths[]` に収まっているか |
| `TEST_RESULT` | test の実行結果 |
| `CI_CHECK` | CI check の完了と結論 |
| `REVIEW` | `REVIEWER` の判定 |
| `SECURITY_REVIEW` | `SECURITY_REVIEWER` の判定 |
| `RISK_ASSESSMENT` | diff 後の risk 再評価結果 |
| `POLICY_CHECK` | policy gate の判定 |
| `APPROVAL_RECORD` | **owner 承認**の記録（`approved_head_sha` を含む）。`approver_kind` は `OWNER` 固定で、role が生成することはできません |

### 7.3 COST-0 additive kind

| kind | 内容 |
|---|---|
| `USAGE_OBSERVATION` | adapter 境界の内側で正規化された usage 観測への参照。agent の自己申告は正本ではありません |
| `PRICING_SOURCE` | 価格の出所への参照（価格表 version / 契約単価 / 請求・精算明細 id）と `effective_at` |

### 7.4 Evidence の規則

| 規則 | 内容 |
|---|---|
| R7-1 | **Evidence は参照であって本文コピーではありません。** raw log / raw prompt / secret / credential / 絶対 path を bundle に入れません |
| R7-2 | **Bundle の完全性は deterministic code が判定**します。agent の所見は bundle を満たしません |
| R7-3 | **Evidence は失効します。** head SHA が動けば `HEAD_SHA` に紐づく evidence は無効になり、再収集が必要です（`EVIDENCE_INVALIDATED`） |
| R7-4 | **`INCONCLUSIVE` は `PASS` ではありません**（fail closed） |
| R7-5 | **§7.3 の 2 kind は `approval_present` を満たしません**（R4-4）。また contract が `required_evidence[]` に明示的に列挙しない限り、`evidence_bundle_complete` の必要条件になりません |
| R7-6 | `PRICING_SOURCE` は価格の**出所**への参照であって、**価格表そのものではありません**。価格表を本契約に hard-code しません |

---

## 8. Failure type v1（閉じた語彙）

**失敗理由を分類してから retry 可否を決めます。** 分類は controller が行います。

| failure_type | 内容 | retry |
|---|---|---|
| `TRANSIENT` | 一時的な I/O・ネットワーク等。同じ入力でも結果が変わり得る | **可** |
| `DETERMINISTIC` | 同じ入力で必ず同じ失敗（test 失敗、契約違反、schema 違反） | **不可**。入力を変えずに繰り返しても結果は変わりません |
| `POLICY` | scope 逸脱、承認欠如、禁止操作の検出 | **不可**。停止して報告します |
| `USAGE_LIMIT` | 利用制限（rate limit / usage credit / model limit） | **不可（hard stop）** |

### 8.1 失敗種別の規則

| 規則 | 内容 |
|---|---|
| R8-1 | `RETRY_SCHEDULED` を発行してよいのは `failure_type = TRANSIENT` かつ `max_attempts` 未達のときだけです |
| R8-2 | **`USAGE_LIMIT` では自動 retry・自動の model 変更・credit の自動消費を行いません。** これは既存の運用契約を維持したものです |
| R8-3 | `failure_type` に provider 名を含めません。provider 固有の失敗は adapter が上表の 4 種へ**正規化**します（R6-2 / R6-6） |
| R8-4 | 分類できない失敗を `TRANSIENT` として扱いません。判定できないものは retry しません（fail closed） |
| R8-5 | stop condition（budget 超過 / kill switch / scope 逸脱検出 / 最上位 risk 該当 / 承認失効のまま protected action へ到達）は `STOPPED` または `EXPIRED` への遷移であり、**それ自体は failure_type ではありません** |

---

## 9. COST-0 usage / cost attribution envelope（additive / optional）

### 9.1 位置づけ

- **optional です。** run event が本 envelope を持たないことは契約違反ではありません（R5-4）。
- **additive です。** 本 envelope の導入は §3〜§8 の語彙を 1 つも変更しません。
- 目的は「今すぐ集計できること」ではなく、
  **「後から集計したくなったときに、過去のデータを捨てずに済むこと」**です。
- 集計・保存・表示・enforcement・価格表は**すべて後続フェーズ**です（§12）。
- envelope は `USAGE_RECORDED` / `COST_ATTRIBUTION_CORRECTED` の `payload` に載ります。
  **既存 wire / 内部 event model の key 集合には追加されません**（§0.2）。

### 9.2 次元（必須 / 任意）

**必須にしたのは「後から復元できないもの」だけです。**

| 次元 | 必須 / 任意 | 内容 | 不明時 |
|---|---|---|---|
| `schema_version` | **必須** | envelope 自身の version。**event の `run_event_contract_version` を置き換えません**（R9-13） | — |
| `tenant_id` | **必須** | 課金の帰属先 | 予約値 `unattributed`（§9.3） |
| `project_id` | 任意 | project 単位の予算がある場合のみ | `null` |
| `run_id` | **必須**（値は `null` 可） | Loop Control Plane の run 識別子 | run 外の消費なら `null`。`attribution_scope` で範囲を明示（R9-3） |
| `task_id` | 任意 | run 内の task | `null` |
| `workflow_id` | 任意 | workflow 定義 | `null` |
| `attribution_scope` | **必須** | 帰属範囲の閉じた語彙（§9.4） | — |
| `logical_role` | **必須** | 論理 role code（`PLANNER` / `EXECUTOR` / `REVIEWER` / `RISK_ASSESSOR` / `SECURITY_REVIEWER` / `HUMAN_REPORTER` / `RESEARCHER`） | 予約値 `unknown_role`（§9.3） |
| `business_category` | 任意 | 業務カテゴリ | `null` |
| `department_id` | 任意 | 部署。区画識別子と**同じ値域**を使う | `null` |
| `agent_instance_id` | 任意 | ephemeral な agent instance の実体識別子 | `null` |
| `provider_dimension` | **必須** | `{ id, resolution }`。`id` は adapter 境界の**内側**で正規化された provider 識別子（nullable）、`resolution` は §9.5 の閉じた語彙 | `{ id: null, resolution: "unresolved" }`。**record は破棄しません** |
| `model_dimension` | **必須** | `{ id, resolution }`。同上 | 同上 |
| `usage_quantities` | **必須** | 単位付き数量の集合。**単位を値と分離して保持**します | provider が報告しない単位は **key ごと欠落**させます（0 で埋めません） |
| `service_cost_items` | 任意 | tool / 外部 service の費用 | `null` |
| `cost_amount` | `cost_status` に従属（§9.6） | 金額。**0 は「0 と分かっている」既知の値**であり「未算出」ではありません | 未算出なら `cost_status = unpriced` かつ不在（0 にしません） |
| `cost_currency` | `cost_amount` があれば**必須** | **ISO 4217**。請求された通貨をそのまま保持します | — |
| `cost_status` | **必須** | `estimated` / `finalized` / `unpriced` の閉じた語彙（§9.6） | `unpriced` |
| `pricing_source` | `estimated` / `finalized` なら**必須** | `PRICING_SOURCE` evidence への参照と `effective_at` | — |
| `attribution_method` | 任意 | 帰属方法。agent の自己申告を採用した場合は**必ず明示**します | `null` |
| `occurred_at` | **必須** | 消費が発生した時刻（ISO-8601） | — |
| `recorded_at` | **必須** | Store が記録した時刻（ISO-8601）。**`occurred_at` と別 field** | — |
| `evidence_ref` | **必須** | Evidence Bundle への参照（§9.7） | — |

**必須 / 任意を分けた基準**:

- `tenant_id` / `run_id` / `attribution_scope` / `logical_role` / `provider_dimension` /
  `model_dimension` / `usage_quantities` / `occurred_at` / `recorded_at` / `evidence_ref` は、
  その時点で記録しないと**永久に復元できません**。
  ただし **「必須」なのは次元そのものであって、解決済みの id ではありません**（§9.3 / §9.5）。
- `department_id` / `business_category` は Company Brain 側の対応表から
  **後から join できる**ため任意です。
- `cost_amount` は価格表があれば `usage_quantities` から**後から算出できる**ため任意です。
  **ただし金額を持つと宣言した `cost_status` では必須です**（§9.6）。
  **逆に `usage_quantities` は常に必須です**（後から観測し直せないため）。

### 9.3 予約値 `unattributed` / `unknown_role`

帰属先が決まらないことは、その消費を**記録しない理由になりません**。
推測して埋めることと、記録ごと落とすことは**どちらも同じ「合計が合わない」を生みます**。

| 予約値 | 適用先 | 意味 |
|---|---|---|
| `unattributed` | `tenant_id` | 帰属先が決まらない消費であることを**明示**する。適当な tenant へ割り振らず、按分せず、黙って捨てない |
| `unknown_role` | `logical_role` | 論理 role が決まらない消費であることを**明示**する |

| 規則 | 内容 |
|---|---|
| R9-1 | `unattributed` / `unknown_role` は**予約値**です。実在の tenant / role の識別子としてこの 2 値を発行してはなりません |
| R9-2 | **必須の 2 軸（`tenant_id` / `logical_role`）は `null` を取りません。** 不明は予約値で表します。一方、**任意の次元の不明は `null`** であって `"unknown"` のような文字列でも `0` でもありません。`0` は「消費が無かった」という別の事実です |
| R9-3 | `run_id = null` は「run 外の消費」という**明示的な事実**であり、`attribution_scope` が範囲を示します（§9.4）。不明を意味しません |
| R9-4 | **`unattributed` / `unknown_role` / `unresolved` / `unpriced` の総量は、常に別掲で集計可能**でなければなりません。「合計が合わない」を検知できないと、帰属漏れが静かに蓄積します |
| R9-5 | **これらを budget 評価の入力から除外しません。** 除外は「消費 0 として続行する」と同じ結果になります |

### 9.4 `attribution_scope`（閉じた語彙）

| 値 | 意味 | 決定論的な必要条件 |
|---|---|---|
| `RUN` | 特定 run に帰属する消費 | `run_id != null` |
| `TASK` | run 内 task に帰属する消費 | `run_id != null` **かつ** `task_id != null` |
| `WORKFLOW` | workflow 定義に帰属する run 外の消費 | `workflow_id != null` |
| `PROJECT` | project に帰属する run 外の消費 | `project_id != null` |
| `DEPARTMENT` | 部署に帰属する run 外の消費 | `department_id != null` |
| `TENANT` | tenant にのみ帰属する消費 | 追加条件なし（`tenant_id` は常に必須） |

| 規則 | 内容 |
|---|---|
| R9-6 | 上表の必要条件を満たさない組み合わせは**契約違反**です |
| R9-7 | `attribution_scope ∉ {RUN, TASK}` のとき `run_id` は `null` でなければなりません。**run に紐づかない消費を run へ寄せません** |

### 9.5 `resolution`（閉じた語彙）と unresolved dimension

**正規化できないことを理由に、usage / cost の record を破棄しません。**
落とすとその消費は「`unattributed` にも計上されない・budget 評価にも入らない・
後から訂正もできない」という最悪の消え方をします。

| `resolution` | 意味 | `id` |
|---|---|---|
| `resolved` | adapter 境界の内側で正規化できた | **非 `null` 必須** |
| `unresolved` | 正規化できなかった | **`null` 必須** |

| 規則 | 内容 |
|---|---|
| R9-8 | **`"unknown_provider"` のような偽の id を発行しません。** 不明は `resolution = unresolved` かつ `id = null` で表します |
| R9-9 | `resolution = unresolved` の record も `usage_quantities` / `occurred_at` / `recorded_at` / `evidence_ref` / `tenant_id` / `logical_role` / `attribution_scope` を**通常どおり保持**します。帰属できる軸が分かっているなら、provider が不明でも**その軸では正しく集計されます** |
| R9-10 | 後から mapping を足して解決できるよう、**正規化できなかった元の識別子への参照（provenance）を adapter 境界の内側に保持**し、`evidence_ref` から辿れる形にします。これは秘匿境界を緩めません（raw prompt / secret / credential / 絶対 path は対象外のままです） |
| R9-11 | 解決したときは **元の record を上書きせず `COST_ATTRIBUTION_CORRECTED` を追加**します。訂正 record は**どの record を訂正したか**と**どの mapping version で解決したか**を持ちます |
| R9-12 | 正規化できない usage 単位名は `unmapped` として**数量を保持**し、捨てません。これは provider / model 次元に対する R9-8 と同じ規則です |

### 9.6 `cost_status` ごとの cross-field invariant（閉じた契約）

`cost_status` は金額 field の**必須性を支配**します。status と金額が独立だと、
`finalized` なのに金額が無い record や `unpriced` なのに金額がある record が
契約上許されてしまいます。

| `cost_status` | `cost_amount` | `cost_currency` | `pricing_source` | 意味 |
|---|---|---|---|---|
| `estimated` | **必須**（数値。`0` も可） | **必須**（ISO 4217） | **必須**。価格表 version / 契約単価と `effective_at` を伴う | 見積り。確定請求に置き換わり得る |
| `finalized` | **必須**（数値。**`0` も有効な確定値**） | **必須**（ISO 4217） | **必須**。請求・精算 evidence の参照を伴う | 確定。請求事実と一致する |
| `unpriced` | **必ず不在 / `null`** | **必ず不在 / `null`** | 不在でよい | **金額が未確定**。数量と provenance は保持する |

| 規則 | 内容 |
|---|---|
| R9-13 | envelope の `schema_version` は **envelope object に閉じた version** です。event の互換 gate は `run_event_contract_version` のままで、両者を同一の値空間として扱いません（R1-3） |
| R9-14 | **`unpriced` は「0」を意味しません。** `0` は「0 と分かっている」既知の値であり、`estimated` または `finalized` として記録します |
| R9-15 | `cost_amount` が存在するなら `cost_currency` は **ISO 4217 で必須**です。通貨不明の金額は合算できません |
| R9-16 | `estimated` / `finalized` は**原本の請求通貨と金額**を保持します。reporting 通貨への換算は**別 field**で持ち、FX rate / rate source / effective time を伴います。**上書きしません** |
| R9-17 | 上表を満たさない組み合わせは**契約違反**です。deterministic code は**黙って補正せず、その金額 field の採用を失敗させて理由を記録**します（理由は field 名 + rule 名のみ・R2-4）。**推測して金額を埋めません** |
| R9-18 | **ただし失敗させるのは金額の採用であって record ではありません。** `usage_quantities` と provenance は `cost_status = unpriced` として保持し、訂正 record で後から確定させます。**「金額が信用できない」ことは「消費が無かった」ことではありません** |
| R9-19 | `estimated` → `finalized` の遷移は**上書きではなく `COST_ATTRIBUTION_CORRECTED` の追加**です（R2-1） |
| R9-20 | 混在した合計を提示する場合、**`estimated` の内訳と `unpriced` の件数を必ず併記**します。片方だけを見て「確定額」と読める表示を作りません |

### 9.7 evidence linkage

| 規則 | 内容 |
|---|---|
| R9-21 | `evidence_ref` は §7 の `evidence_id` への**参照の集合**です。明細本文を複製しません |
| R9-22 | `cost_status ∈ {estimated, finalized}` の record は、`evidence_ref` に **`PRICING_SOURCE` kind の evidence を少なくとも 1 件**含まなければなりません。`pricing_source` はその evidence への参照と `effective_at` で構成されます |
| R9-23 | 正本は **adapter が正規化した観測値**（`USAGE_OBSERVATION`）であり、agent の自己報告ではありません。agent の報告を採用する場合は `attribution_method` に明示し、**補助的 evidence** として扱います |
| R9-24 | **採用値を決めるのは deterministic code** です。agent は提案できますが、判断しません |
| R9-25 | cost 計上のためだけに **prompt 本文・secret・credential・機微 payload を保持しません。** token 数を数えるのに prompt 本文は不要で、**数量だけを保持**します。明細の照合は **id 参照**で行います |

### 9.8 COST-0 が決めないもの

- provider 価格表、換算率、単価といった**具体的な数値**
- telemetry の取得・正規化の実装、集計・保存、dashboard / UI
- budget policy の閾値、警告・承認・停止の enforcement
- business value / ROI の語彙と算出（後続 VALUE-1 の範囲）
- 按分ルール、価格表の version 管理機構、請求 API との突合

cost 事象が停止・承認を要する場合、**既存の risk / approval / stop 機構へ写像**します。
**cost 専用の停止経路を新設しません**（R5-3）。

---

## 10. provider 中立検査との関係

本文書は **provider 中立であるべき契約文書**です。したがって:

| 規則 | 内容 |
|---|---|
| R10-1 | 本 file の path は [provider-neutral-scan.manifest.json](provider-neutral-scan.manifest.json) の `include_paths` に含まれます |
| R10-2 | 本文に **provider 名・vendor 名・brand 名・model 名・model family 名を書きません**。必要な場合は [role-binding-registry.md](role-binding-registry.md) を参照します |
| R10-3 | 禁止 token の権威 source は [role-binding-registry.md](role-binding-registry.md) ただ 1 つです。本文書は token 一覧を持ちません |
| R10-4 | 本 file について宣言済みの exception は **0 件**です。1 件でも hit があれば FAIL です |
| R10-5 | manifest の照合規則（正規化・部分一致・fail closed）は manifest 側と registry 側が持ちます。本文書は再定義しません |
| R10-6 | **CI での実行は後続 WF-1（分類 C）**です。本文書と manifest は判定に必要な宣言を揃えるところまでです |

---

## 11. 用語と不変条件の突き合わせ（reconciliation）

本文書の作成にあたり、2 つの source 設計の記述の間で**判断が必要だった点**を明示します。
いずれも source の判断を撤回せず、**決定論にするための最小の確定**に留めています。

| # | 論点 | 確定 | 根拠 |
|---|---|---|---|
| 1 | `RUN_STALLED` は状態か event か | **event code**（§5.1）。状態語彙は 16 のまま増やしません | 本体設計の状態表は閉じた語彙として提示されており、stall は「進行が観測できない」観測事実です（R3-1） |
| 2 | 不明の表し方が 2 通りある（予約値 `unattributed` / `unknown_role` と、`{id: null, resolution}`） | **軸ごとに使い分けを固定**。tenant / role は予約値、provider / model は `{id, resolution}`（§9.3 / §9.5） | cost 追補は tenant / role に予約値を、provider / model に `resolution` 構造を指定しています。両者は矛盾ではなく適用先が違います。「偽の id を発行しない」は両方で守られます |
| 3 | 「不明な次元は `null`」と「必須軸は予約値」の関係 | **必須の 2 軸は `null` を取らず予約値、任意の次元は `null`**（R9-2） | 必須軸を `null` にすると「記録し忘れ」と「帰属不能」が区別できなくなります |
| 4 | `attribution_scope` が散文でしか定義されていない | **必須 field へ昇格し、閉じた語彙と必要条件を定義**（§9.4） | 「run 外なら `run_id = null` + `attribution_scope` で明示」を deterministic に判定可能にするため |
| 5 | envelope の `schema_version` と互換 gate の衝突 | **envelope object に閉じた version とし、互換 gate は `run_event_contract_version`**（R1-3 / R9-13） | 「`schema_version` のみが互換 gate」の原則を保ちつつ、envelope 自身の版も持てます |
| 6 | cost 用の evidence kind | **`USAGE_OBSERVATION` / `PRICING_SOURCE` を additive に追加**し、`approval_present` を満たさないことを明示（§7.3 / R7-5） | cost 追補が「evidence linkage」を LCP-1 の範囲に含めています。承認権限は OWNER のみという判断は不変です |
| 7 | 失敗種別の code 表記 | **UPPER_SNAKE の閉じた語彙 4 種**（§8） | 本体設計は日本語の分類名で提示していましたが、閉じた語彙は英語 UPPER_SNAKE で表示は日本語 label へ写像する規則に従いました |
| 8 | budget 閾値・警告・enforcement の event code | **v1 に含めない**（R5-3） | cost 追補は LCP-1 への追記を「範囲を最小限拡張」に限定し、enforcement を後続 COST-3 に置いています |
| 9 | `RISK_DEESCALATED` の存在 | **code は置くが、owner 承認 evidence を伴わない発行を契約違反とする**（§5.4 / R4-9） | 降格自体は owner 承認により起こり得ます。監査証跡に残す必要があるため code は必要です |
| 10 | この文書が既存 2 契約の key を増やすか | **増やしません**（§0.2） | 両 source が「wire schema / 内部 event model を変更しない」と明示しています |

---

## 12. この文書の対象外

- Loop Control Plane / Run/Event Store / Management Console / adapter の**実装**
- 永続化基盤の選定、依存追加、database / service の導入
- wire protocol の変更、SSE frame の追加、write / control endpoint の追加
- 既存 SSE surface への shell 実行 / mutation / approval mutation の追加
- workflow / hooks / permissions / secrets / 認証の変更
- provider 中立 scan を走らせる **CI の実装**（後続 WF-1・分類 C）
- 価格表・換算率・単価、telemetry の取得、集計・保存、dashboard / UI、budget enforcement
- business value / ROI の語彙と算出（後続 VALUE-1）
- 物理 schema（JSON key の綴り、型、必須性の実装表現）の確定
- 外部 repository への接触・変更、無関係な refactor

---

## 13. 未決事項

**推測で埋めてはいけない項目**です。

| # | 項目 | 決める場所 |
|---|---|---|
| 1 | Run / Event Store の実体（file / 埋め込み / 外部） | STORE-1 |
| 2 | lease の TTL と stall threshold の具体値 | STORE-1 |
| 3 | budget の cost unit の定義（`max_cost_unit` の単位） | COST-1 以降。**本文書は `usage_quantities` が単位を値と分離して持つことだけを固定**しています |
| 4 | Quest が run event を受ける経路の具体（namespace 分離の作法は決定済み、受け口の形が未決） | LCP-3 |
| 5 | 汎用 status 表示面の具体（banner 拡張か第 2 面か、code 名、DOM 構造） | ORG-PR-1（方式）／ORG-PR-3（実装） |
| 6 | 顧客 / project / 部署の識別子体系（`tenant_id` / `project_id` / `department_id` の値域） | Company Brain 側の事実。ORG-PR-1 と同根 |
| 7 | provider 側 usage / billing の取得経路 | COST-1 |
| 8 | 本文書の語彙に対応する物理 schema（JSON key 名・型） | STORE-1 の実装 PR |

### 13.1 この文書が置いている前提

- **前提 A**: Quest の read-only / loopback / GET のみ / CORS header なしの境界を将来も維持する。
- **前提 B**: 承認者は OWNER のみで、論理 role は protected な遷移を authorize しない。
- **前提 C**: 利用制限時に自動 retry しない hard stop 方針を維持する（R8-2）。
- **前提 D**: 権威 run source（STORE-1）より先に production の read model を出さない。
