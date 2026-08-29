# Loop Control Plane / Provider Independence 設計記録（ロードマップ改訂）

Claude Quest を **Loop Engineering / Human-on-the-Loop 中心の AI Company 構成**へ軌道修正する
ための設計記録です。**この文書はコードを変更しません。** 新しい wire schema、API、SSE event、
runtime 挙動、環境変数、依存のいずれも追加しません。

この文書が決めるのは **責務境界・契約の形・段取り** だけです。
新規要素の実装 field 名・関数名・DOM 構造は、対応する実装 PR で決めます（仮称も置きません）。
既存の名称と `file:line` は観測した事実として引用します。

実装とこの文書が食い違った場合は、常に **実装（`src/`）が正** です。

関連: [event-contract.md](event-contract.md) / [live-wire-contract.md](live-wire-contract.md) /
[org-snapshot-design.md](org-snapshot-design.md)

**この文書の言語**: 日本語散文 + 英語識別子。既存 docs の慣行に合わせています（§11）。

---

## 目次

| § | 内容 |
|---|------|
| [1](#1-現在の-clean-breakpoint-と検証済みリポジトリ状態) | 現在の clean breakpoint と検証済みリポジトリ状態 |
| [2](#2-目標とする責務境界) | 目標とする責務境界 |
| [3](#3-loop-contract-v1概念schema) | Loop Contract v1（概念 schema） |
| [4](#4-run-state-machine-v1) | Run State Machine v1 |
| [5](#5-event-schema-の原則) | Event schema の原則 |
| [6](#6-evidence-bundle) | Evidence Bundle |
| [7](#7-動的-risk-escalation-と-approval-policy) | 動的 risk escalation と approval policy |
| [8](#8-retry--stall--heartbeat--idempotency-の原則) | Retry / stall / heartbeat / idempotency の原則 |
| [9](#9-agent-role-model--agent-contract-v1) | Agent Role Model / Agent Contract v1 |
| [10](#10-provider-adapter-境界と移行戦略) | Provider Adapter 境界と移行戦略 |
| [11](#11-communication--language-policy) | Communication / language policy |
| [12](#12-quest--management-console--control-plane-の責務) | Quest / Management Console / Control Plane の責務 |
| [13](#13-prompt--context--harness--loop-監査) | Prompt / Context / Harness / Loop 監査 |
| [14](#14-既存-org-snapshot--roster-ロードマップの移行) | 既存 org-snapshot / roster ロードマップの移行 |
| [15](#15-次pr候補依存順) | 次 PR 候補（依存順） |
| [16](#16-この文書と本フェーズの対象外) | この文書と本フェーズの対象外 |
| [17](#17-architecture-acceptance-criteriaprovider-置換) | Architecture acceptance criteria（provider 置換） |
| [18](#18-未決事項観測できていないこと) | 未決事項（観測できていないこと） |

---

## 1. 現在の clean breakpoint と検証済みリポジトリ状態

### 1.1 このタスクで実際に観測した事実

`HEAD = b29611cf062ff5b315d8cbdb9fff9f9699293a87`（`chore(ci): remove assigned issue trigger (#18)`）
の作業ツリーを読んで確認した内容です。

| 観測 | 確認方法 | 結果 |
|------|----------|------|
| 重複 Claude issue-trigger 修正が完了している | `git log`、`.github/workflows/claude.yml:8-13` | **確認済み**。`issues:` trigger は `opened` のみ。理由が同 file の comment に残っている |
| test が通る | `npm test` | **338 pass / 0 fail**（依存追加なし） |
| 依存ゼロ | `package.json`、`package-lock.json`（282 bytes） | **確認済み**。runtime / dev とも依存なし |
| Quest runtime が read-only | `src/server/server.ts:174`（GET 以外を拒否）、`src/server/server.ts:31`（`127.0.0.1` 固定）、`README.md:113-115` | **確認済み**。state を変更する endpoint は存在しない |
| endpoint 一覧 | `README.md:117-125` | `GET /` `/ui/*.css` `/ui/*.js` `/health` `/events/live` `/events/demo` のみ |
| `docs/org-snapshot-design.md` の Phase 2 継続計画が残っている | 同 file `§5`（PR-1 〜 PR-5） | **確認済み**。削除していません（§14 で再配置） |
| docs は 3 件 | `ls docs/` | `event-contract.md` / `live-wire-contract.md` / `org-snapshot-design.md` |
| `src/live.ts` が `ActorDirectory` を渡していない | `src/live.ts:29-50` | **確認済み**。`npm run live` / `npm run demo` の実行経路では role は event の `agent_role` 由来のみ。`org-snapshot-design.md:41` の記述は現在も有効 |
| CI workflow が有効化されている | `.github/workflows/ci.yml` | **確認済み**。`ci/quest-core-ci.yml.example` から owner が適用済み。`npm ci` → `npm test` → typecheck |
| workflow 自体に regression test がある | `test/claude-workflow.test.ts:1-18` | **確認済み**。trigger 面・権限・fork 拒否・concurrency group・bot allowlist を pin している |

### 1.2 陳腐化していた前提

issue 本文の「開始時点で open な Quest issue / PR が無いはず」という前提について:

- **この issue（#19）自体が open** なので、文字どおりには既に成立していません。
- それ以外の open issue / PR の有無は **確認できていません**。本 run の `--allowedTools`
  （`.github/workflows/claude.yml:176`）は `npm` の 4 コマンドのみを許可しており、`gh` CLI は
  含まれていないためです。GitHub API 由来の事実は §18 に未確認として分離します。

これは §13 の Harness 監査で挙げる矛盾の実例です。prompt が「自分で確認せよ」と要求している
context を、harness が取得させない構成になっています。

### 1.3 観測した不整合（本タスクでは修正しない）

`.github/workflows/claude.yml` が `docs/automation-protocol.md` を 2 箇所で参照しています
（`:183` の comment と `:353` の失敗通知本文）が、**このファイルは repository に存在しません**。

失敗通知は owner が読む運用文書へ誘導する目的の文言なので、リンク切れのまま運用すると
「利用制限ハードストップ」の運用契約が参照先を失います。

| 選択肢 | 分類 | 備考 |
|--------|------|------|
| `docs/automation-protocol.md` を新規作成して実態に合わせる | A（docs のみ） | 参照先の内容を owner が確定する必要がある。**内容は未決**なので本タスクでは推測で書きません |
| workflow 側の参照を削る | **C** | `.github/workflows/**` の変更。GitHub App は workflow を書けず（`README.md:406-407`）、本タスクの禁止事項でもある |

**本タスクでは記録のみとし、どちらも実施しません。** §15 の PR 候補に切り出します。

### 1.4 この breakpoint が「キリのよい地点」である理由

- ingest から描画までの全経路が test で固定されている（338 件）。
- 外部 wire → adapter → 内部 validator の 3 段が完成している。これは §10 の provider adapter
  境界の**実装済みの先例**であり、今回の軌道修正で捨てるものではありません。
- 未実装として明示されている領域（org / roster / 区画）は、設計だけが
  `org-snapshot-design.md` に分離されており、中途半端な実装が残っていません。

つまり **「壊れかけの実装を抱えたまま方針転換する」状態ではない**ため、
ここで責務境界を引き直せます。

---

## 2. 目標とする責務境界

7 層に分けます。**上位層は下位層の内部表現に依存しません。**

| 層 | 責務 | 責務**でない**もの | 現在地 |
|----|------|------------------|--------|
| **Company Brain** | 会社・事業の永続知識（組織定義、方針、製品、規約、用語） | run state、進行中の作業、一時的な判断 | このリポジトリには**無い**。`org-snapshot-design.md:199-209` の外部 org 定義がここに属する（実在未確認） |
| **Loop Control Plane** | goal、Loop Contract、run state machine、scheduler / queue、policy / risk、approval、retry budget、lease / lock、heartbeat、idempotency、stop condition、evidence、kill switch、audit trail | 業務内容の判断、UI、provider の選定 | **無い**。GitHub Actions の workflow 定義と人間の運用が暗黙に分担している |
| **Agent Workers** | 役割ごとの提案・生成・検証（§9 の role 一覧） | 状態遷移の確定、承認、自分の risk 分類の引き下げ | Claude Code Action の 1 run が複数 role を兼務。Codex/ChatGPT が review 経路にいる（`claude.yml:163`） |
| **GitHub** | code / diff / issue / PR / review / CI / merge の **evidence source** | real-time な run state の唯一のデータベース | evidence source としては機能している。run state は持っていない |
| **Run / Event Store** | run と遷移の永続 machine-readable 履歴 | 業務判断 | **無い**。Quest の state は process memory のみで、再起動で消える（`README.md:356-357`） |
| **Management Console** | Human-on-the-Loop の運用監督と（将来の）認証済み介入 | 体験としての可視化、直接の executor 起動 | **無い**。GitHub の issue 画面が代替している |
| **Claude Quest** | role / run / work / 承認待ち / stall / failure / 完了 の **read model・可視化・体験層** | 状態の書き込み、承認、command 実行、**control 要求の送信**（§12.2） | Claude Code Hook stream の可視化までは実装済み。run の概念は無い |

### 2.1 層をまたぐ規則

1. **run state を書けるのは Loop Control Plane だけ**です。Agent も Quest も Console も書きません。
2. **Quest は provider 名を知りません。** role code と state code だけを読みます（§10、§17）。
3. **GitHub は正本ではなく observer 対象**です。GitHub が落ちても run 履歴は Run/Event Store に残ります。
4. **Company Brain と Run/Event Store は混ぜません。** 「誰が在籍しているか」と「今どの run が
   どの状態か」は寿命も更新頻度も権威も違います。これは `org-snapshot-design.md:90-120` が
   「org snapshot は event stream ではない」として既に確立した分離と同じ形です。
5. **Quest の安全境界は層をまたいでも緩めません**（§12.2）。

---

## 3. Loop Contract v1（概念 schema）

Loop Contract は **1 つの goal を run へ落とすときに、開始前に固定される契約**です。
run の途中で書き換えません。変更が必要なら新しい contract の新しい run にします。

```
LoopContract (contract_version: 1)   ── 概念。実 field 名は実装 PR で決める
  contract_version        : 1
  goal_id                 : 安定した識別子
  goal_statement_ja       : owner の原要求（正本・§11）
  goal_spec_en            : canonical execution spec（任意・日本語に従属）
  success_criteria[]      : { kind: MACHINE | HUMAN, predicate_or_statement }
  stop_conditions[]       : 明示的な停止述語（§8.5）
  scope
    allowed_paths[]       : 変更してよい path
    forbidden_paths[]     : 変更してはいけない path
    allowed_operations[]  : 閉じた語彙
    forbidden_operations[]: 閉じた語彙
  risk
    initial_class         : A | B | C | D（**宣言値。確定値ではない**・§7）
    escalation_rules[]    : deterministic に判定できる昇格条件
  approval
    required_before[]     : protected action の種別
    approver_kind         : OWNER | NONE（**`ROLE` は取りません**・§7.6）
    role_attestation_required[] : 承認ではない role 検証の要求（§7.6）。
                            `REVIEW` / `SECURITY_REVIEW` evidence として記録され、
                            **`approval_present` を満たしません**
  budget
    max_attempts / max_wall_clock / max_agent_invocations / max_cost_unit
  roles[]                 : { role: ROLE_CODE, agent_contract_ref }
  required_evidence[]     : protected action 前に揃っていなければならない evidence kind（§6）
  language_policy_ref     : §11 への参照
  idempotency
    run_key               : 同一 goal の重複起動を吸収する key（§8.1）
    dedupe_scope          : key の有効範囲
```

### 3.1 原則

- **contract は immutable。** run 開始時に固定します。
- **contract に自由記述の作業指示を入れません。** 自由記述は `goal_statement_ja` /
  `goal_spec_en` に閉じます。残りは全て閉じた語彙か参照です。
- **contract は provider 名を持ちません。** role は `agent_contract_ref` を指し、
  provider の選定は Role Binding（§10.1）だけが行います。
- **scope は許可制**です。「これをするな」の列挙ではなく `allowed_paths[]` を正本にします。
  禁止の列挙は網羅できないので、deterministic gate にできません（§13 の中心的な指摘）。

### 3.2 現在地との対応

**この issue の本文自体が、手書きの Loop Contract です。**
execution profile（risk class 宣言）、scope（allowed / 禁止）、非目標、completion evidence、
human report の言語指定が揃っています。

欠けているのは内容ではなく **機械可読性と強制力** です。現状はすべて自然言語で書かれ、
守られたかどうかを判定するのは実行中の agent 自身です。Loop Contract v1 の目的は、
この issue 本文と同じ情報を **controller が検証できる形**にすることです。

---

## 4. Run State Machine v1

状態は **閉じた語彙**（`[A-Z][A-Z0-9_]*`）です。表示用の日本語 label は別途 mapping します
（`README.md:202-216` の banner と同じ作法）。

### 4.1 状態

| state | 意味 | 終端 |
|-------|------|------|
| `CREATED` | contract が確定し run が採番された | |
| `PLANNING` | PLANNER が計画を提案中 | |
| `PLAN_REVIEW` | 計画に対する review / policy check | |
| `BLOCKED_ON_INPUT` | owner への質問待ち。時間経過では進まない | |
| `EXECUTING` | EXECUTOR が作業中 | |
| `EVIDENCE_COLLECTING` | evidence を集めている（test、CI、diff scope 等） | |
| `REVIEWING` | REVIEWER / SECURITY_REVIEWER の検証中 | |
| `RISK_ASSESSING` | diff が存在した後の risk 再評価（§7.2） | |
| `AWAITING_APPROVAL` | protected action 前の owner 承認待ち | |
| `APPROVED` | 承認済み。`approved_head_sha` が紐づく | |
| `APPLYING` | protected action の実行中（merge / 適用 / 送信） | |
| `VERIFYING` | 適用後の観測（post-merge observer） | |
| `SUCCEEDED` | success_criteria を満たして完了 | ✔ |
| `FAILED` | 失敗が確定し retry 予算も尽きた | ✔ |
| `STOPPED` | stop condition / kill switch により停止 | ✔ |
| `EXPIRED` | budget / timeout 超過 | ✔ |

### 4.2 遷移の規則

| 規則 | 内容 |
|------|------|
| **単一 writer** | 遷移を書けるのは controller のみ。agent は proposal を返すだけで、遷移を宣言できない |
| **guard は deterministic** | 各遷移に code で判定できる guard を置く。LLM の判断は guard の**入力**にはなるが、guard そのものにはならない |
| **`APPLYING` の guard** | `evidence_bundle_complete == true` **かつ** (`risk_class ∈ {A, B}` **または** (`approval_present == true` **かつ** `approved_head_sha == observed_head_sha`)) |
| **`approval_present` の定義** | **OWNER の `APPROVAL_RECORD` だけが `true` にできます**（§7.6）。role 由来の `REVIEW` / `SECURITY_REVIEW` / `POLICY_CHECK` は evidence bundle には寄与しますが、`approval_present` を満たしません |
| **kill switch** | 任意の非終端状態から `STOPPED` へ遷移できる |
| **承認は時間で進まない** | `AWAITING_APPROVAL` から先へ進むには approval record が必要。timeout は `EXPIRED` へ落とすだけで、承認したことにはしない |
| **approval は SHA に紐づく** | `approved_head_sha` と実際の head が違えば approval は失効し、`AWAITING_APPROVAL` へ戻る |
| **risk 昇格は割り込む** | `RISK_ESCALATED` が起きたら、`APPLYING` に入る前に必ず `AWAITING_APPROVAL` を経由する |
| **再入は冪等** | 同じ transition が重複配信されても 2 回適用しない（§8.1） |
| **終端は不可逆** | 終端状態から戻りません。やり直しは新しい run |

### 4.3 attempt と run の区別

`run` は goal に対する 1 本の loop、`attempt` はその中の実行試行です。
retry は **同じ contract・新しい `attempt_id`** で行い、run を作り直しません（§8.4）。
run 単位の budget と attempt 単位の budget は別に持ちます。

---

## 5. Event schema の原則

`docs/event-contract.md` が既に確立している作法を、run/event 側へそのまま引き継ぎます。
**新しい作法を発明しません。**

### 5.1 原則

1. **閉じた語彙。** `event_code` は enum。provider 名・model 名を含む event code を作りません。
2. **`schema_version` のみが互換 gate**（`event-contract.md:23`）。それ以外の値は観測情報です。
3. **必須 key は常に全て存在**し、値が無い場合は明示的な `null`。key 欠落は拒否
   （`event-contract.md:25`）。
4. **未知 key は drop** し、外へ出しません（`event-contract.md:28`、`src/domain/wire.ts:61`）。
5. **1 event = 1 事実。** 派生値・集計値を event に持たせません。state は event の fold です。
6. **append-only / immutable。** 訂正は上書きではなく補償 event で表します。
7. **provider 固有情報は adapter envelope の中にだけ置き**、core event の field へ昇格させません（§10.2）。
8. **禁止内容 check を run event にも適用します**（絶対 path / credential / shell 断片。
   `event-contract.md:58-66`）。拒否理由は field 名 + rule 名のみで、内容を含めません。
9. **相関 field**: `goal_id` / `run_id` / `attempt_id` / `role` / `causation_id` / `correlation_id`。
10. **順序は受信側が採番します。** producer 由来の seq は診断用に留めます
    （`event-contract.md:82` と同じ判断）。

### 5.2 event family（provider 中立の code 例）

概念上の分類です。**確定した code 一覧はこの文書では決めません**（§15 LCP-1 で確定）。

| family | 例 |
|--------|-----|
| run lifecycle | `RUN_CREATED` / `RUN_STATE_CHANGED` / `RUN_STOPPED` |
| role 実行 | `ROLE_INVOKED` / `ROLE_COMPLETED` / `ROLE_FAILED` |
| evidence | `EVIDENCE_ATTACHED` / `EVIDENCE_REJECTED` |
| risk | `RISK_CLASSIFIED` / `RISK_ESCALATED` |
| approval | `APPROVAL_REQUESTED` / `APPROVAL_GRANTED` / `APPROVAL_DENIED` / `APPROVAL_INVALIDATED` |
| 制御 | `RETRY_SCHEDULED` / `BUDGET_EXHAUSTED` / `LEASE_ACQUIRED` / `LEASE_LOST` / `HEARTBEAT` / `STOP_REQUESTED` |

`heartbeat` は既存の内部 event model に既に存在する `event_type` です
（`event-contract.md:52-53`）。**この既存資産を作り直しません。**

### 5.3 Quest 側の受け口

Quest は run event を **read model として**受けます。既存の LIVE / DEMO 分離の作法
（`README.md:302-310`：別 store instance、state・seq・dedupe・replay buffer・subscriber を共有しない）を
そのまま踏襲し、run stream も独立した namespace として扱います。混ぜません。

---

## 6. Evidence Bundle

**Evidence とは「controller が deterministic に検証できる観測結果への参照」**です。
agent の主張ではありません。

### 6.1 形

```
Evidence (概念)
  evidence_id     : 安定した識別子
  kind            : 閉じた語彙（下表）
  ref             : 観測対象への参照（URL / SHA / check id など）。**本文のコピーではない**
  observed_at     : 観測時刻
  observer_role   : どの role が観測したか
  digest          : 参照先の同一性を確認するための要約値
  verdict         : PASS | FAIL | INCONCLUSIVE
```

| kind | 内容 |
|------|------|
| `HEAD_SHA` | 対象の head SHA |
| `DIFF_SCOPE` | 変更された path 集合が `allowed_paths[]` に収まっているか |
| `TEST_RESULT` | test の実行結果 |
| `CI_CHECK` | CI check の完了と結論 |
| `REVIEW` | REVIEWER の判定 |
| `SECURITY_REVIEW` | SECURITY_REVIEWER の判定 |
| `RISK_ASSESSMENT` | diff 後の risk 再評価結果 |
| `POLICY_CHECK` | policy gate の判定 |
| `APPROVAL_RECORD` | **owner 承認**の記録（`approved_head_sha` を含む）。`approver_kind` は `OWNER` 固定で、role が生成することはできません（§7.6） |

### 6.2 原則

- **Evidence は参照であって本文コピーではありません。** raw log / secret / 絶対 path を
  bundle に入れません（`README.md:373-375` の作法と整合）。
- **Bundle の完全性は deterministic code が判定します。** `required_evidence[]` の全 kind が
  `PASS` で揃って初めて `evidence_bundle_complete == true` です。agent の「問題なさそうです」は
  bundle を満たしません。
- **Evidence は失効します。** head SHA が動けば `HEAD_SHA` に紐づく evidence は無効になり、
  再収集が必要です。
- **INCONCLUSIVE は PASS ではありません。** 判定できなかったものを通しません（fail closed）。

### 6.3 現在地との対応

この issue の "Completion evidence" 節（変更 docs の提示、diff scope が docs のみであることの提示、
test 実行、runtime file 不変の報告、仮定と事実の分離）は、**手書きの Evidence Bundle 要求**です。
現状これを検証するのは実行中の agent 自身で、controller ではありません。

---

## 7. 動的 risk escalation と approval policy

### 7.1 分類（A / B / C / D）

| class | 範囲 | 人間の関与 |
|-------|------|-----------|
| **A** | docs / comment のみ。runtime 影響なし | Human-on-the-Loop（事後確認） |
| **B** | code 変更・runtime 影響ありだが、既存の read-only / loopback 境界の内側で、test により判定可能 | Human-on-the-Loop（evidence と policy gate を通過すれば自動可） |
| **C** | workflow / hooks / permissions / secrets / 認証 / 依存追加 / 外部 repository への mutation / write・control endpoint の追加 / protected な merge | **Human-in-the-Loop。protected action の前に owner 承認必須** |
| **D** | 禁止。secret の露出、fork への write token 付与、任意 shell 実行 endpoint、無認証 mutation、検知回避 | 実施しない |

### 7.2 再評価の要件（この設計の中心の一つ）

**Loop Contract の `initial_class` は宣言値にすぎません。** diff が存在する前の分類は
「意図の申告」であって、実際に何を触ったかの観測ではないからです。

- `RISK_CLASSIFIED` は **最低 2 回**発生させます。**(a) 計画確定後**、**(b) diff が存在した後**。
- (b) は `RISK_ASSESSING` 状態で行い、**`APPLYING` より前**に必ず通ります。
- 昇格した場合は `RISK_ESCALATED` を出し、`AWAITING_APPROVAL` へ割り込みます。

### 7.3 昇格は自動・降格は承認制（monotonic escalation）

| 方向 | 誰が決められるか |
|------|-----------------|
| **昇格**（A → B → C → D） | deterministic gate が自動で行える。RISK_ASSESSOR も昇格を提案できる |
| **降格**（C → B など） | **owner 承認が必要**。agent は降格できない |

理由: 昇格の誤りは「余計に止まる」だけですが、降格の誤りは「止まるべきところで止まらない」に
なります。非対称な失敗コストには非対称な権限を割り当てます。

### 7.4 deterministic に判定できる昇格 trigger

LLM の判断を待たずに code で判定できるものは、code 側に置きます。

- `.github/workflows/**` / hooks / permissions / secrets 関連 path への変更 → **C**
- `package.json` / lockfile の依存追加 → **C**
- 新しい非 GET route、外部送信、shell 実行の追加 → **C**（内容次第で **D**）
- `allowed_paths[]` の外への変更 → 少なくとも **C**（scope 逸脱そのもの）
- 外部 repository への write → **C**

RISK_ASSESSOR（LLM）は、この一覧に無い懸念を**追加で**提案できますが、
一覧が出した昇格を取り消せません。

### 7.5 現在地との対応

本タスクは class A 宣言で始まり、「もし workflow に触る必要が出たら停止して報告せよ」という
昇格規則が書かれていました。実際に §1.3 の `docs/automation-protocol.md` 参照切れが見つかり、
workflow 側の修正は **C** に当たるため、**この文書は修正せず記録して停止**しています。
つまり §7.2 の再評価と §7.3 の昇格を、今回は人手で 1 回実行した形です。
Loop Control Plane の目的は、これを毎回の人手ではなく controller の常設機能にすることです。

### 7.6 承認は OWNER のみ。role の検証は承認ではない

**protected action（class C）の承認者は OWNER だけです。** logical role（§9.1）は、
どれも protected な state 遷移を authorize できません。

| 概念 | 誰が作るか | `approval_present` を満たすか | 記録先 |
|------|-----------|------------------------------|--------|
| **owner approval** | OWNER（人間） | **満たす**（唯一） | `APPROVAL_RECORD`（`approver_kind: OWNER`・`approved_head_sha` 必須） |
| **role attestation**（検証・所見） | `REVIEWER` / `SECURITY_REVIEWER` / `RISK_ASSESSOR` / `POLICY_CHECK` 実行主体 | **満たさない** | `REVIEW` / `SECURITY_REVIEW` / `RISK_ASSESSMENT` / `POLICY_CHECK` evidence |

- role attestation は **非 authorizing な review evidence** です。`required_evidence[]`（§3）の
  一部として `evidence_bundle_complete` に寄与しますが、**それ単独でも全部揃っても、
  `APPLYING` / merge / protected な支出 / 介入操作を authorize しません**。
- したがって `approver_kind` に `ROLE` は存在しません（§3）。role による検証を要求したい場合は
  `role_attestation_required[]` を使い、`approval` とは別の field に分けます。
- `approver_kind: NONE` を選べるのは、`required_before[]` が空、すなわち protected action を
  一切含まない contract の場合だけです。**class C 以上を含む contract は `OWNER` 固定**です。
- これは §9.1 の「`EXECUTOR` 以外は read-only」「agent は遷移を宣言できない」（§4.2 単一 writer）と
  同じ理由づけです。**変更主体も検証主体も、自分の作業を通す権限を持ちません。**

---

## 8. Retry / stall / heartbeat / idempotency の原則

### 8.1 Idempotency

- `run_key = f(goal_id, trigger_identity)` を controller が採番し、**同一 trigger の重複配信は
  同じ run_key に落として 1 本の run にします**。
- event 側は `event_id` による重複排除を行います（既存 collector と同じ作法、
  `event-contract.md:79`）。
- **現状は冪等ではありません。** `.github/workflows/claude.yml:26-28` の concurrency group は
  「同時に 1 本」を保つだけで、同 file の comment 自身が *「3 本目の request が来たとき pending が
  cancel される」* と認めています。重複を**排除**しているのではなく**取り落として**います。
  これは意図された挙動ですが、冪等性とは別物です。

### 8.2 Lease / lock

- run ごとに lease を取り、**lease holder だけが遷移を書けます**。
- lease は TTL 付きで、heartbeat により更新します。
- lease を失った実行主体の書き込みは拒否します（split-brain 防止）。

### 8.3 Heartbeat と stall 検出

- 実行中の role は `HEARTBEAT` を定期的に出します。
- `last_heartbeat_at + stall_threshold < now` を controller が判定し、`RUN_STALLED` を扱います。
  **判定は時計と閾値だけで行い、LLM に問い合わせません。**
- 現状の stall 対策は step timeout 30 分 / job timeout 45 分（`claude.yml:132,152`）のみで、
  **外から進行中かどうかを観測する手段がありません**。

### 8.4 Retry

- retry は attempt 単位。`max_attempts` は Loop Contract の budget（§3）。
- **失敗理由を分類してから retry 可否を決めます。**

| 失敗種別 | retry |
|----------|-------|
| transient（一時的な I/O、ネットワーク） | 可 |
| deterministic（同じ入力で必ず同じ失敗。test 失敗、契約違反） | **不可**。入力を変えずに繰り返しても結果は変わらない |
| policy（scope 逸脱、承認欠如） | **不可**。停止して報告する |
| 利用制限（rate limit / usage credit / model limit） | **不可（hard stop）** |

利用制限で自動 retry・model 変更・credit の自動消費を行わない方針は、既に
`.github/workflows/claude.yml:180-182` に運用契約として書かれています。**この既存方針を維持します。**

### 8.5 Stop conditions

以下は controller が deterministic に判定し、`STOPPED` / `EXPIRED` へ落とします。

- budget（attempts / wall clock / invocations / cost unit）の超過
- 明示 kill switch
- scope（`allowed_paths[]` / `forbidden_operations[]`）の逸脱検出
- class **D** に該当する操作の検出
- 承認が失効したまま protected action に到達

---

## 9. Agent Role Model / Agent Contract v1

### 9.1 論理 role

**provider 名・model 名を role にしません。**

| role | 責務 | write 権限 |
|------|------|-----------|
| `PLANNER` | goal を実行計画へ分解し提案する | なし |
| `EXECUTOR` | 計画に沿って変更を作る | **あり**（branch への commit / push） |
| `REVIEWER` | 変更の正しさを検証する | なし |
| `RISK_ASSESSOR` | risk class を評価し、昇格を提案する | なし |
| `SECURITY_REVIEWER` | 安全境界・secret・権限の観点で検証する | なし |
| `HUMAN_REPORTER` | owner 向けの日本語報告を作る（§11） | なし |
| `RESEARCHER`（任意） | 事実確認・調査 | なし |

**`EXECUTOR` 以外は read-only です。** 分離しないと、変更した主体が自分の変更を承認する
構造になります。

### 9.2 Agent Contract v1（概念）

```
AgentContract (agent_contract_version: 1)
  role                   : ROLE_CODE
  input_schema_ref       : この role が受け取る入力の schema
  output_schema_ref      : この role が返す出力の schema（**自由記述ではない**）
  capabilities[]         : 閉じた語彙（READ_REPO / RUN_TESTS / WRITE_BRANCH / POST_COMMENT / ...）
  allowed_tools[]        : 許可制
  forbidden_tools[]      : 明示的な禁止（allowed_tools の補助であって代替ではない）
  permissions            : 最小権限。role ごとに独立して与える
  budget                 : { max_wall_clock, max_cost_unit, max_tool_calls }
  retry_policy           : { max_attempts, retryable_failure_kinds[] }
  required_evidence[]    : この role が返さなければならない evidence kind（§6）
  risk_constraints
    max_actionable_class : この role が行動してよい上限 class
    may_escalate         : true
    may_deescalate       : false            ← 例外なく false（§7.3）
    may_approve          : false            ← 例外なく false（§7.6。承認は OWNER のみ）
  determinism_expectation: PROPOSAL_ONLY | VERIFIABLE_OUTPUT
```

### 9.3 原則

- **どの role の output も proposal です。** controller が検証して初めて事実になります。
- **role は provider を知りません。** 束縛は Role Binding（§10.1）だけが行います。
- **output は schema に従います。** 「仮定と事実を分けて書け」のような要求は散文の指示ではなく、
  output schema の別 field にします。
- **capability は許可制**です。禁止列挙だけに頼りません（§3.1 と同じ理由）。

### 9.4 現在地との対応

現状、`.github/workflows/claude.yml` の 1 job が **PLANNER + EXECUTOR + REVIEWER +
RISK_ASSESSOR + HUMAN_REPORTER を同時に兼務**しています。独立した検証主体としては、
`allowed_bots`（`claude.yml:163`）経由の Codex review が唯一です。
SECURITY_REVIEWER と RISK_ASSESSOR は role として存在しません。

**この兼務自体が、§7.3 の「変更主体が自分の risk を評価する」構造**です。
role 分離は provider を増やすためではなく、この構造を解消するために必要です。

---

## 10. Provider Adapter 境界と移行戦略

```
Loop Control Plane
   │  role contract（provider 名なし）
   ▼
Role Binding        ← provider 名が現れてよい唯一の場所
   │
   ▼
Provider Adapter    ← provider 固有の起動・prompt 組み立て・tool 名 mapping・失敗分類の正規化
   │
   ▼
provider runtime    （Claude Code / ChatGPT Work / Codex / その他）
```

### 10.1 Role Binding

`role -> { adapter_id, adapter_config_ref }` の設定表です。
**provider を変えるとは、この表の行を差し替えることだけを意味します。**

### 10.2 Adapter の責務と非責務

| Adapter の責務 | Adapter の**非**責務 |
|----------------|---------------------|
| provider 固有の起動・認証の扱い | state 遷移の決定 |
| role の input schema → provider 入力への変換 | approval の判定 |
| provider 出力 → role の output schema への変換 | risk 分類の決定 |
| provider 固有の失敗を共通の失敗種別（§8.4）へ正規化 | retry 回数の決定 |
| provider 固有の進捗を core event code（§5.2）へ写像 | evidence の合否判定 |

**Adapter は core event を生成できますが、core event に provider 固有 field を足せません。**
これは既存の `toWireEvent`（`src/domain/wire.ts:61`）の作法そのものです。producer object を
spread せず field 単位で組み立てるため、producer 側の schema 追加が黙って外へ漏れません。

### 10.3 既存の実装済み先例

このリポジトリには **既に provider adapter 境界が 1 本実装されています**。

```
外部 wire (Claude Code Hook, rich/nested)
   → src/domain/hookWire.ts    : model した key だけを組み立てる（fail closed）
   → src/domain/hookAdapter.ts : mapping 表の行だけを使う
   → src/domain/validate.ts    : 内部 model として **もう一度**検証する
```

`README.md:368-370` が明示するとおり、**adapter の出力を内部 validator へ再投入する**構造です。
mapping が変わっても内容規則が効き続けます。

**role 側の adapter も同じ 3 段構成を採ります。** 新しい枠組みを発明しません。

### 10.4 移行戦略（段階）

| 段階 | 内容 | code 変更 |
|------|------|-----------|
| M0 | 現在の provider 構成を Role Binding 表として**文書化するだけ** | なし |
| M1 | core の state code / event code / evidence kind を provider 中立で確定 | なし（docs） |
| M2 | **最小の権威ソース**（Run/Event Store と単一 writer の deterministic controller）を先に立てる | あり |
| M3 | Run Read Model を Quest が read-only で受ける（供給元は M2） | あり（read-only の範囲） |
| M4 | provider 追加は adapter + binding 行の追加のみ。contract / state machine / Quest read model は不変 | adapter のみ |
| M5 | provider 撤去は binding 行の差し替え。過去 run の履歴は Store に残り、provider に依存しない | binding のみ |

**M1 を M2 より先に置くことが重要です。** provider 名を含む event code を一度でも作ると、
以後の置換が必ず read model まで波及します。

**M2 を M3 より先に置くことも同じく重要です。** read model は権威ソースの射影であり、
権威ソースより先に production の read model を置くと、供給のために一時的な第 2 の権威を
発明することになります（§15 の依存順もこの理由で組んでいます）。

---

## 11. Communication / language policy

| 面 | 言語 | 位置づけ |
|----|------|---------|
| owner からの原要求 | **日本語** | **正本** |
| canonical execution spec | 英語可 | 日本語要求に**従属** |
| agent 間 / runtime の定型連携 | machine-readable（JSON Schema / ID / event code / state code / evidence reference） | 自然言語より優先 |
| 複雑な技術指示 | 原則英語 | |
| 人間向けの進捗 / 承認 / 失敗 / 完了報告 | **日本語** | |
| repository 文書 | 日本語散文 + 英語識別子 | 既存 docs の慣行 |
| code / identifier / code comment | 英語 | 既存 `src/` の慣行 |

### 11.1 規則

1. **衝突時は日本語の owner 要求が勝ちます。** 英語 spec が日本語要求と食い違ったら、
   推測で辻褄を合わせず、**衝突そのものを surface** します。
2. **token 節約のための独自記号言語を作りません。** 監査できない通信は evidence になりません。
3. **閉じた語彙は英語 UPPER_SNAKE**、表示は日本語 label へ写像します。
   **未知の code は表示しません**（`README.md:213-216` の作法：wire の自由記述をそのまま出さない）。
4. **人間向け報告は「事実」と「未確認の仮定」を別 field に分けます**（§9.3）。

---

## 12. Quest / Management Console / Control Plane の責務

| | **Loop Control Plane** | **Management Console** | **Claude Quest** |
|---|---|---|---|
| run state への権限 | **唯一の writer** | 認証済み Control API 経由で**要求**する | **要求もしない**（strictly read-only・§12.2） |
| 中心に置くもの | goal / contract / state / policy / risk / approval / evidence / budget | 同じものの運用ビュー + 介入 | role / run / work / 承認待ち / stall / failure / 完了 の**体験**  |
| 主な利用者 | machine | owner（運用・監督） | owner（把握・体験） |
| provider 名 | 持たない（Role Binding のみ） | **出さない**（§17） | **知らない**（§17） |
| 表示の自由記述 | — | 最小限 | **不可**（閉じた語彙のみ） |

### 12.1 Quest の位置づけ

Quest は **Control Plane ではありません。** AI Company の Run State / Event を可視化する
**read model / experience layer** です。この文書はこの位置づけを固定します。

「read-only」は **server が GET のみを受ける**という意味に留まりません。Quest は
**control 要求を送る client にもなりません**。表示している事実に対して操作を発生させる手段を、
Quest の server 側にも UI 側にも持たせません。

### 12.2 この計画で緩めない Quest の安全境界

- **GET のみ**（`src/server/server.ts:174`）、**loopback 固定**（`:31`、bind host は設定不可）、
  **CORS header なし**、**Host allowlist**（`README.md:377-378`）。
- **既存の SSE surface に、shell 実行 / GitHub mutation / approval mutation / POST control
  endpoint を直接足しません。**
- **Quest は将来の mutation / 介入の要求経路に一切現れません。** 送信元にも中継にもしません。
- 将来 mutation が必要になった場合、要求の起点は **Management Console**、または
  **明示的に分離された認証済みの運用 client** のみです。経路は次だけです。

  ```
  Management Console（または明示的に分離された認証済み運用 client）
    → authenticated Control API → Policy / Approval Gate（§7.6：承認は OWNER のみ）
    → Executor
  ```

  この経路は **Quest の process にも UI にも属しません**。Quest 側に増えるのは、
  「承認待ちが存在する」という read-only な事実の表示だけで、そこから操作へは繋ぎません。
- 上記は **LIVE（実在の run に対する承認）** の話です。`npm run demo` の scripted DEMO が
  `awaiting_approval` で停止した時に受け付ける `approve`（起動 terminal の stdin、1 語のみ）は
  これに含まれません。承認する対象は実在の run ではなく **DEMO の台本の次の 1 beat** で、
  LIVE store / LIVE stream / Control API のいずれにも到達せず、HTTP surface も UI の
  read-only 性も変更しません。DEMO が「時間の経過だけで承認されたと主張する」ことを
  防ぐためだけに存在します（`README.md`「承認の仕組み」）。
- 静的 asset の exact match 解決、`textContent` 経由のみの DOM 挿入、
  whitelist field のみの出力（`README.md:365-390`）は不変です。

---

## 13. Prompt / Context / Harness / Loop 監査

現在の Quest 開発アーキテクチャを 4 つのレンズで監査します。

### 13.1 Prompt

| 区分 | 内容 |
|------|------|
| **実装済み** | issue 本文が execution profile / scope / 非目標 / completion evidence / 報告言語を構造的に指定している。workflow が model と effort を pin し、default 変更で黙って別 model に移らないようにしている（`claude.yml:169-175`） |
| **部分的** | role 分離が prompt 内の自然言語でしか表現されていない。output の形式も散文指定 |
| **欠落** | role 別の system contract、output schema の強制、prompt 内容の version 管理 |
| **重複** | 失敗時 notice が `docs/automation-protocol.md` を運用契約の正本として参照しているが、その file が無い（§1.3）。結果として prompt が唯一の指示源になり、単一障害点化している |
| **将来不要** | 「これをするな」の長い禁止リスト。§3.1 のとおり path allowlist と permission で deterministic に効かせるべきもの |

### 13.2 Context

| 区分 | 内容 |
|------|------|
| **実装済み** | 契約の正本が repo 内 docs にある（event-contract / live-wire-contract / org-snapshot-design）。全 docs が「実装が正」を明示しており、drift 時の優先順位が決まっている |
| **部分的** | 前回 run の決定が issue コメントに散在する。機械可読な run 履歴が無いため、context の再構成が毎回 repo 読み直しになる |
| **欠落** | Company Brain（org 定義は外部・実在未確認、`org-snapshot-design.md:199-209`）、Run/Event Store |
| **重複** | README と各 docs に同じ制約が二重記述されている。意図的な冗長だが drift 源でもある |
| **将来不要** | run のたびに issue 本文へ現在地を貼り直す運用。Run Read Model があれば参照で足りる |

### 13.3 Harness

| 区分 | 内容 |
|------|------|
| **実装済み** | deny-by-default permissions（`claude.yml:31`）、job ごとの再付与、actor gate、fork head の拒否、`--allowedTools` allowlist、concurrency group、失敗時の 1 回だけの notice（run id で dedupe）、CI（`npm ci` → test → typecheck）、**workflow 自体の regression test**（`test/claude-workflow.test.ts`）。この層は既にかなり強い |
| **部分的** | `--allowedTools` が npm 4 コマンドのみ。今回 `gh` が無く GitHub 状態を確認できなかった（§1.2）。**prompt が「自分で確認せよ」と要求する context を harness が取得させない**という矛盾が実際に発生した |
| **欠落** | diff scope の自動 gate（`allowed_paths[]` を CI で強制）、risk 分類の自動判定、approval gate、lease / heartbeat、idempotency key、kill switch |
| **重複** | 重複配信対策が concurrency group と guard job に分散し、**どちらも idempotency ではない**（§8.1） |
| **将来不要** | 「workflow を変更するな」を prompt で頼む部分。GitHub App が `.github/workflows/` を書けない事実（`README.md:406-407`）で構造的に担保済み。prompt 側は重複 |

### 13.4 Loop

| 区分 | 内容 |
|------|------|
| **実装済み** | trigger → guard → 1 run → comment → push → 人間確認、という 1 周が成立している。利用制限時に自動 retry しない hard stop 方針が明文化されている（`claude.yml:180-182`） |
| **部分的** | 停止条件が step timeout 30 分 / job timeout 45 分のみ（`claude.yml:132,152`）。budget も attempt 予算も無い |
| **欠落** | 永続 run state、状態遷移、retry 予算、stall 検出、kill switch、post-merge observer、eval |
| **重複** | run の「現在地」が issue コメント本文・workflow run log・branch state の 3 箇所にあり、**どれも正本ではない** |
| **将来不要** | 人間が issue コメントを読んで run が生きているか判断する運用 |

### 13.5 自然言語が harness を代行している箇所（重点）

**この一覧が、今後 deterministic 化すべき対象の優先リストです。**

| # | 現在: prompt の自然言語で頼んでいること | 将来: deterministic に効かせる場所 |
|---|--------------------------------------|----------------------------------|
| 1 | 「`.github/workflows/**` を変更するな」 | path gate（`allowed_paths[]`）。現状は App 権限と prompt の二重頼み |
| 2 | 「diff が docs のみであることを示せ」 | CI の diff scope check（`DIFF_SCOPE` evidence） |
| 3 | 「完了前に test を実行せよ」 | required check（`TEST_RESULT` / `CI_CHECK` evidence）。CI は既にあるが run 側の gate が無い |
| 4 | 「risk が上がったら停止して報告せよ」 | risk gate + `AWAITING_APPROVAL` 状態（§7.2） |
| 5 | 「同じ内容で 2 回走らせるな」 | idempotency key（§8.1）。現状は concurrency group |
| 6 | 「日本語で報告せよ」 | `HUMAN_REPORTER` の output contract（§9） |
| 7 | 「未解決の仮定を事実と分けて書け」 | output schema の別 field（§9.3） |
| 8 | 「依存を追加するな」 | lockfile diff gate。CI の `npm ci` が既に半分担っている |

1 〜 3 と 8 は **既存の CI / 権限構成にほぼ材料が揃っており**、gate 化のコストが小さい部類です。
4 〜 7 は Loop Control Plane 本体を待ちます。

---

## 14. 既存 org-snapshot / roster ロードマップの移行

**`docs/org-snapshot-design.md` の設計は破棄しません。** 検証済みの設計判断
（org snapshot は event stream ではない、3 通りの突き合わせ規則、縮退の可視化義務、
決定論的 layout）はすべて有効なままです。

新架構での位置づけは **Quest = experience layer**（§12.1）であり、
org / roster はまさにその experience layer の入力です。矛盾しません。

### 14.1 既存 PR 候補の再配置

| 既存（`org-snapshot-design.md` §5） | 新ロードマップでの扱い | 理由 |
|---|---|---|
| **PR-1** org 定義の事実確認と入力契約の確定（A） | **順序維持・位置づけを拡張** | 確認対象の外部 org 定義は、新架構では **Company Brain**（§2）そのもの。Quest 固有の入力確認ではなく、Company Brain の入力契約確認として一段上に位置づけ直す。§4.1〜§4.7 の未決項目自体は変更なし |
| **PR-2** org snapshot 読み取りと検証（B） | **順序維持** | 「event が作らない事実」を read-only で取り込む型を確立する。Run Read Model（§5.3）も同じ型を使うため、先に通す価値がむしろ上がった |
| **PR-3** roster projection と突き合わせ + 縮退表示（B） | **順序維持・ただし縮退表示契約を汎用化** | **唯一の実質的な変更点。**下記 §14.2 |
| **PR-4** 決定論的な区画 layout と固定席座標（B） | **後ろへ移動可（並行可）** | 見た目の完成度であり、Loop Control Plane の前提ではない。Run Read Model より後でも困らない。ただし **split はしない**（分割すると座標の決定論を 2 回検証することになる） |
| **PR-5** 縮退経路の最終整合と README 更新（A） | **維持・末尾** | 変更なし |

**supersede（廃止）される既存 PR 候補はありません。**

### 14.2 PR-3 に対する唯一の実質的変更: 表示面の汎用化

`org-snapshot-design.md:247-260`（§4.7）は、org の縮退状態を
「既存 banner の語彙を 1 増やす」か「別の閉じた語彙の status 表示面を置く」かを未決とし、
**その決定を PR-1 で行う**としています。

新架構では、閉じた語彙で示したい状態が org 縮退だけではなくなります。

- org snapshot の 採用 / 不在 / 拒否
- run state（§4.1）
- approval 待ち
- stall / failure

これらは全て「stream の健全性とは独立した、閉じた語彙の状態」です。
既存 banner に混ぜると `FAIL_CLOSED` / `DISCONNECTED` を押しのけて **stream 異常を隠す**
という §4.7 が指摘した問題が、org 以外の理由でも起きます。

**したがって PR-1 で表示面を決めるとき、org 専用ではなく「stream 状態を隠さない、
閉じた語彙の第 2 status 面」として決めることを推奨します。**
これは §4.7 が既に置いている判断基準（閉じた語彙のみ・自由記述なし・stream 状態を隠さない）を
広げるだけで、基準そのものは変えません。

この推奨は **PR-1 が LCP-1（§15）に依存する**ことを意味します。表示面を 2 度決めないためです。

> **【後日訂正】この依存は成立しませんでした。** PR-1 は §4.7 で、表示面の
> **存在と契約**（第 2 面である・閉じた語彙である・banner を隠さない）までを確定し、
> **語彙の中身は org 分だけ先に定義**する形を採りました。表示面を 2 度決める問題は
> それで解けており、ORG-PR-1 / ORG-PR-3 / ORG-PR-4 はいずれも LCP-1 未着手のまま
> 完了しています（PR #35 / #37）。LCP-1 が要るのは、run state の code を
> **この第 2 面へ追加する**ときだけです。以下 §14.3 の順序推奨も同様に失効しています。

### 14.3 新規に挿入する位置

- 本文書（LCP-0）と PR-1 は **どちらも docs のみ・相互依存なし**なので並行可能です。
- ~~ただし §14.2 の理由により、PR-1 の §4.7 決定は LCP-1 の後に行うのが望ましい構成です。~~
  **失効**（§14.2 の訂正）。PR-1 は LCP-1 を待たずに完了しました。
- PR-1 の §4.1〜§4.6 は外部事実の確認なので、LCP-1 と**並行して owner 側で進められます**。

---

## 15. 次 PR 候補（依存順）

分類は §7.1 の A / B / C / D です。**見積もりであり、diff 後に再評価されます**（§7.2）。

| id | 内容 | 依存 | 分類（見積） |
|----|------|------|------------|
| **LCP-0** | 本設計文書の追加（この PR） | なし | **A** |
| **LCP-1** | Run / Event contract v1 の docs 化。state code / event code / evidence kind / 失敗種別の**閉じた語彙を確定**する。成果物は `docs/run-event-contract.md` / `docs/role-binding-registry.md` / `docs/provider-neutral-scan.manifest.json` の 3 件（§15.2）。code 変更なし | LCP-0 | **A** |
| **ORG-PR-1** | 既存 §5 PR-1。外部 org 定義の事実確認 + §4.7 の表示面決定を**汎用 status 面として**確定（§14.2） | **なし**（下記の訂正）| **A** ✅ **完了**（Issue #23） |
| **LCP-2** | §13.5 の 1〜3・8 を deterministic gate にする**設計**（docs） | LCP-1 | **A**（設計のみ） |
| **DOC-1** | `docs/automation-protocol.md` の新規作成（§1.3）。内容は owner が確定 | owner の内容決定 | **A** |
| **WF-1** | §1.3 の workflow 側参照の整合、LCP-2 の gate の**実装**、および §17.2 manifest を読む provider 中立 scan の CI 実装 | LCP-1（manifest）／LCP-2 / DOC-1 | **C**（workflow 変更。owner 承認・owner 実施） |
| **ORG-PR-2** | 既存 §5 PR-2。org snapshot 読み取りと検証 | ORG-PR-1 | **B** ✅ **完了**（PR #27・上限修正 #33） |
| **STORE-1** | **最小の権威 run source**。永続 Run / Event Store と単一 writer の deterministic controller（§4.2）。**run state の供給元はここに一本化される** | LCP-1 / LCP-2 | **C**（永続化基盤の導入。owner 承認必須） |
| **LCP-3** | Run Read Model を Quest が read-only で受ける。独立 namespace、GET のみ、既存 SSE surface に mutation を足さない。**供給元は STORE-1** | LCP-1 / ORG-PR-2（取り込みの型を共有）／**STORE-1**（供給元） | **B** |
| **ORG-PR-3** | 既存 §5 PR-3。roster projection + 汎用 status 面での縮退表示 | **ORG-PR-2 のみ**（下記の訂正）| **B** ✅ **完了**（PR #35） |
| **MC-1** | read-only Management Console（Goal / Run / State / Role / Risk / Approval / Evidence 中心） | **STORE-1** / LCP-3 | **B** |
| **ORG-PR-4** | 既存 §5 PR-4。決定論的 layout と固定席座標 | ORG-PR-3 | **B** ✅ **完了**（PR #37） |
| **OBS-1** | Eval / post-merge observer / recovery | STORE-1 | **C** |
| **ORG-PR-5** | 既存 §5 PR-5。縮退経路の最終整合と README 更新 | ORG-PR-4 | **A** ⏳ **実施中**（PR #40） |
| **CTRL-1** | 認証済み介入操作（Control API + Policy/Approval Gate）。**起点は Management Console または明示的に分離された認証済み運用 client のみで、Quest は含みません**（§12.2） | STORE-1 / OBS-1 / MC-1 | **C**（安全基盤が揃うまで着手しない） |

**訂正（ORG-PR-1 / ORG-PR-3 の依存）**: この表は当初 `ORG-PR-1` の表示面決定を `LCP-1` に、
`ORG-PR-3` の依存に `LCP-3` を挙げていましたが、
これは**古い記述です**。後から確定した
[`org-snapshot-design.md`](org-snapshot-design.md) §4.7 が明示的に上書きしています —
第 2 status 面の**存在と契約**（第 2 面である・閉じた語彙である・banner を隠さない）までを
確定し、**語彙の中身は org 分だけ先に定義**する、という決定です。run state 側の code は
LCP-1 確定後に同じ面へ追加します。したがって **ORG-PR-3 は LCP-1 も LCP-3 も待ちません**。
§14.2 の「PR-1 の §4.7 決定は LCP-1 の後が望ましい」という推奨も、この決定が優先します。
実際に **ORG-PR-1 / ORG-PR-3 / ORG-PR-4 は LCP-1 未着手のまま完了しています**。
§15.1 の「LCP-1 を先に置かないと PR-1 をやり直す」という理由も、同じ決定により失効済みです。
LCP-1 が要るのは、run state の code を**この第 2 面へ追加する**ときだけです。

### 15.0 権威ソースと consumer の順序規則

**production の run projection（Quest / Management Console）は、権威 run source より先に
出しません。** STORE-1 を LCP-3 / MC-1 より前に置き、`STORE-1 → LCP-3 → MC-1` の
一方向依存にしているのはこのためです。**STORE-1 が MC-1 に依存する形は取りません。**
source と consumer の所有関係が反転するからです。

- STORE-1 より前に read model / Console の見た目を試したい場合、それは
  **fixture 専用の非 production prototype に限ります**。fixture 由来の run state は
  **runtime の権威になれません**。production 経路へ昇格させず、STORE-1 の完成後に
  供給元を STORE-1 へ差し替えます。
- この順序規則は **将来の provider-independent run / control plane** に対するものです。
  **既存の検証済み Quest MVP（loopback / GET-only の Claude Code Hook event 表示）は
  対象外**で、そのまま維持します（§12.2）。

### 15.1 推奨する次の 1 件

**LCP-1: Run / Event contract v1 の docs 化。分類 A（docs のみ・runtime 影響なし・owner 承認不要）。**

理由:

1. **依存が LCP-0 のみ**で、外部事実の確認を必要としません。今すぐ着手できます。
2. ~~ORG-PR-1 の §4.7 表示面決定が LCP-1 に依存します~~ — **この理由は失効しました**。
   §4.7 は表示面の**存在と契約**だけを確定し、語彙は org 分から始めると決めたため、
   ORG-PR-1 は LCP-1 を待たずに完了しています（表を参照）。表示面を 2 度決める心配は
   すでにありません。run state の code を**同じ面へ追加する**ときに LCP-1 が要るという
   関係だけが残ります。
3. **§10.4 の M1 に相当**し、provider 名を含む event code が生まれる前に語彙を固定できます。
   ここを飛ばすと、以後の provider 置換が必ず read model まで波及します。
4. code 変更ゼロなので、この breakpoint の 338 件の test を一切揺らしません。

**owner 側で並行して進められるもの**: ORG-PR-1 の §4.1〜§4.6（外部 org 定義の実在確認）と、
DOC-1 の内容決定。どちらもこのリポジトリの外の事実に依存し、agent 側では確認できません。

### 15.2 LCP-1 の完了 evidence（provider 中立検査を executable にするための成果物）

LCP-1 は語彙の確定だけでなく、**基準 4（§17）を機械判定可能にする成果物**を含みます。
下の 3 件が揃って初めて LCP-1 は完了です。**いずれも `docs/` 配下の宣言のみで、
runtime・workflow・依存を変更しないため、LCP-1 は分類 A のままです。**

| 成果物（path 固定） | 内容 |
|---|---|
| `docs/run-event-contract.md` | Run / Event contract v1。state code / event code / evidence kind / 失敗種別の閉じた語彙 |
| `docs/role-binding-registry.md` | M0（§10.4）相当の provisional Role Binding 表。**forbidden token の唯一の権威 source**（§17.2.2） |
| `docs/provider-neutral-scan.manifest.json` | 基準 4 の `include_paths` / `forbidden_tokens` / `exceptions` を持つ manifest（§17.2） |

- **manifest の `include_paths` は、LCP-1 完了時点で `docs/event-contract.md` と
  `docs/run-event-contract.md` の 2 件を含みます**（§17.2.1）。
- **CI での実行は WF-1（分類 C）** です。LCP-1 は判定に必要な宣言を揃えるところまでで、
  検査を走らせる workflow は owner 承認・owner 実施の範囲に留めます（§15 の WF-1 行）。

---

## 16. この文書と本フェーズの対象外

明示的に **やらない / 先送りする** ものです。

- Loop Control Plane、Run/Event Store、Management Console、Agent Adapter の**実装**
- provider の移行そのもの
- wire protocol の変更、SSE frame の追加、write / control endpoint の追加
- 既存 SSE surface への shell 実行 / GitHub mutation / approval mutation の追加
- org snapshot の ingestion / UI の実装（`org-snapshot-design.md` §5 の担当範囲）
- database / cloud service の導入、依存の追加
- `.github/workflows/**` / hooks / permissions / secrets / 認証の変更
- 新規の内部 API 名・field 名・関数名・DOM 構造の確定（各実装 PR の範囲）
- 確定した event code / state code の一覧（**LCP-1 の範囲**。本文書の §4.1 / §5.2 は概念例）
- §15.2 の 3 成果物そのものの作成（**LCP-1 の範囲**。本文書が決めるのは path と拘束条件だけ）
- §17.2 manifest を読む provider 中立 scan の **CI 実装**（**WF-1 の範囲**・分類 C）
- 外部 repository への接触・変更
- 無関係な refactor
- Phase 3（操作 API、指示送信、歩行・自由移動、音声入力）

---

## 17. Architecture acceptance criteria（provider 置換）

将来 provider を入れ替えたときに、**アーキテクチャが壊れていないことを判定する基準**です。
実装が進むたびにこの表へ照らします。

| # | 基準 | 検証の考え方 |
|---|------|-------------|
| 1 | `PLANNER` の provider を差し替えても **Loop Contract と Run State Machine が変わらない** | Role Binding の 1 行だけが変わる diff になること |
| 2 | `REVIEWER` の provider を差し替えても **Event Schema が変わらない** | core event code 一覧に diff が出ないこと |
| 3 | ChatGPT Work を撤去しても **永続 run state が失われない** | Run/Event Store が provider を跨いだ履歴を保持していること |
| 4 | provider 固有の変更が **adapter / 設定境界に局所化**される | **`docs/provider-neutral-scan.manifest.json`（§17.2）の `include_paths` に限定**して同 manifest の `forbidden_tokens` を §17.3 の規則で照合し、**宣言済み exception を除いた hit が 0** であること。repository 全文検索ではありません。**LCP-1 の完了時点で pass / fail を機械判定できます**（§15.2） |
| 5 | Quest が **provider 固有の event 名を必要とせず** role / run state を描画できる | Quest の read model に provider 名の field が存在しないこと |
| 6 | Management Console が **Goal / Run / State / Role / Risk / Approval / Evidence を中心に据える**（provider / model 名ではなく） | 画面の主要 field に provider / model が現れないこと |
| 7 | webhook / workflow の**重複配信を controller が冪等に扱える** | 同一 trigger の 2 回配信が 1 本の run に落ち、遷移が二重適用されないこと（§8.1） |
| 8 | **owner 承認が必要な risk 昇格が protected action の前で停止できる** | `RISK_ESCALATED` 後、承認なしに `APPLYING` へ到達する経路が存在しないこと。かつ **role 由来の attestation が `approval_present` を満たす経路が存在しないこと**（§4.2 / §7.6） |
| 9 | role の追加が **既存 role の contract を変えない** | 新 role 追加の diff が binding と新 contract のみであること |
| 10 | Quest の安全境界が **provider 構成に依存しない** | GET のみ / loopback 固定 / CORS なし が、どの provider 構成でも不変であること（§12.2） |

### 17.1 基準 4 の検索対象と除外（executable にするための scope）

このリポジトリは **意図的に provider 名を含みます**（`README.md`、`.github/workflows/claude.yml`、
Claude Code Hook 取り込み経路、test、そしてこの設計文書自身）。したがって
**repository 全文検索では、provider 分離が正しく実装されていても基準 4 は必ず失敗します。**

一方で **`docs/**` を一括除外することもしません。** 除外の単位が広すぎると、
provider 中立であるべき契約文書へ provider 名が漏れても検査が素通りします。
**除外は「その file が意図的に provider 名を含む」と説明できる単位でのみ行い、
個々の path を名指し**します。判定に使う集合は散文ではなく §17.2 の manifest が持ちます。

| | 内容 |
|---|---|
| **検索対象**（`include_paths`） | provider 中立な契約文書・schema・型・read model interface。**現時点で名指しできるのは `docs/event-contract.md` と、LCP-1 が作る `docs/run-event-contract.md`**（§17.2） |
| **除外**（名指し。`include_paths` に入れない） | `docs/loop-control-plane-design.md`（本文書。設計・説明のため provider 名を含む）／`docs/live-wire-contract.md`（外部 wire = adapter 面の mapping 表）／`docs/org-snapshot-design.md`／`docs/role-binding-registry.md`（§10.1：provider 名が現れてよい唯一の場所）／`README.md`／`.github/workflows/**`／`test/**` と fixture／Provider Adapter の実装・設定（`src/domain/hookWire.ts`・`src/domain/hookAdapter.ts` を含む） |

- **除外は「見逃してよい」ではありません。** 除外面に provider 名が増えること自体は正常で、
  基準 4 が見ているのは「中立面へ漏れたか」だけです。
- **adapter / config / Role Binding は恒久的に `include_paths` へ入れません。**
  provider 名を持つことがそれらの責務だからです（§10.1 / §10.2）。

### 17.2 `docs/provider-neutral-scan.manifest.json`（LCP-1 が作る検査 manifest）

基準 4 の判定に必要な集合を、散文ではなく **1 個の check-in された machine-readable
manifest** に持たせます。**この PR では作成しません**（LCP-1 の成果物・§15.2）。

- **path**: `docs/provider-neutral-scan.manifest.json`（固定）
- **schema の責務**: **LCP-1 が normative schema を確定**します。本節はその拘束条件です。
- **分類**: `docs/` 配下の宣言データのみで、runtime が読む経路を持ちません。
  したがって **LCP-1 は分類 A（docs 契約のみ）のまま**です。
  **この manifest を実際に走らせる CI の実装は WF-1（分類 C）**であり、LCP-1 に含めません。

```
ProviderNeutralScanManifest (manifest_version: 1)
  manifest_version    : 1
  token_source_ref    : "docs/role-binding-registry.md"   ← 唯一の権威 source（下記）
  token_source_digest : materialize 時の token_source_ref の内容 digest
  forbidden_tokens[]  : token_source_ref から展開して**実体化済み**の token 文字列
  include_paths[]     : 検査対象の**実在する** path（glob ではなく完全 path）
  exceptions[]        : { path, token, expected_occurrences, reason, owner,
                          expires_at | expires_with }
```

#### 17.2.1 `include_paths` の規則

1. **完全 path のみ**を並べます。ディレクトリ glob は使いません。
2. **LCP-1 時点の初期値は次の 2 件**です。どちらも provider 中立であるべき契約文書です。
   - `docs/event-contract.md`（既存の内部 normalized event model）
   - `docs/run-event-contract.md` — **LCP-1 が確定する Run / Event contract v1 の成果物。
     この path 名を本節で固定**し、「LCP-1 が作る何か」という記述に留めません。
3. **将来の中立 source / schema / read model file は、実在してから追加**します。
   追加は、その file を新規作成する PR が **同じ PR 内で `include_paths` へ 1 行加える**
   ことを完了条件とします（§15.2 と同じ扱いを各 PR へ適用）。
4. **`include_paths` に列挙された path が存在しない場合は FAIL** です（skip ではありません）。
   rename / 削除による静かな検査縮小を防ぎます。この規則により、
   **まだ存在しない将来 path が現在の判定を曖昧にすることはありません**
   （存在しないものは列挙されていないため）。

#### 17.2.2 `forbidden_tokens` の権威 source

- **権威 source は `docs/role-binding-registry.md` ただ 1 つ**です。これは §10.4 の M0
  （現在の provider 構成を Role Binding 表として文書化するだけ）に相当する成果物で、
  **LCP-1 が provisional binding artifact として作ります**。
- 同 registry は行ごとに **`provider_id` / vendor・brand alias / model family・brand alias**
  を宣言します。**`forbidden_tokens[]` はその和集合を manifest 側へ実体化した値**です。
- **実体化するのは再現性のため**です。scan は manifest の値だけを読み、
  意味的カテゴリの解釈も、provider の live API 参照も行いません。
- `token_source_digest` が `token_source_ref` の実内容と一致しない場合は **FAIL** です。
  registry を更新したのに manifest を再実体化していない状態を検出します。

### 17.3 照合規則（false negative を避けるための最小仕様）

1. **正規化**: 検査対象文字列と token の双方に、同じ正規化を適用します。
   **NFKC → 小文字化 → `[-_./ ]` の連続を半角空白 1 個へ畳む**。
2. **照合**: 正規化後の文字列に対する **部分一致**。
   これにより `Claude Code` / `claude-code` / `claude_hook_v2` は
   いずれも `claude code` / `claude hook v2` へ落ち、token `claude` が一致します。
   **区切り違いの alias を token 側で列挙する必要はありません。**
3. **期待結果**: **宣言済み exception を差し引いた hit が 0 なら PASS**、1 件でも残れば FAIL。
4. **fail closed**。正規化により稀に false positive が出ますが、
   それは exception として **明示的に記録**して通します。黙って通す経路は作りません。

#### 17.3.1 例外の表し方

**広いディレクトリ除外の代わりに、1 件ずつ記録**します。

| field | 内容 |
|---|---|
| `path` | 対象 file の完全 path（`include_paths` の要素であること） |
| `token` | 対象 token（`forbidden_tokens[]` の要素であること） |
| `expected_occurrences` | 正規化後の期待 hit 数。**実測がこれを超えたら FAIL**（既存例外に紛れて新しい漏れが増えるのを防ぐ） |
| `reason` | なぜその file にその token が現れてよいかの説明 |
| `owner` | OWNER（例外の追加・延長は承認事項・§7.6） |
| `expires_at` / `expires_with` | **どちらか一方が必須**。`expires_at` は ISO-8601 日付、`expires_with` は §15 の roadmap id。**期日超過、または当該 roadmap 項目の完了で FAIL** |

**LCP-1 が seed する例外は 1 件**です。`docs/event-contract.md` は現時点で
token `claude` を 4 箇所含みます（外部 wire が別契約であることの説明、
LIVE store の `inputContract` 値 `claude_hook_v2`、`runtime_agent_type` の語義説明、
`internal_task` の由来説明）。いずれも **中立 model の field 名・閉じた語彙ではなく、
adapter 境界を指す説明と binding 値**なので、例外として通し、
**`expires_with` を LCP-3**（Quest の Run Read Model が STORE-1 由来の中立 event を
受ける時点）に置きます。そこで記述を中立化できたか再判定します。

この 1 件を宣言した状態で、**基準 4 は LCP-1 完了時点で PASS になります**。
つまりこの基準は「provider 分離が正しければ通る」検査として成立します。

---

## 18. 未決事項（観測できていないこと）

**推測で埋めてはいけない項目**です。§1.1 の「観測した事実」とは厳密に分離します。

### 18.1 このタスクで確認できなかった事実

| # | 項目 | 理由 |
|---|------|------|
| 1 | 本 issue 以外に open な Quest issue / PR があるか | 本 run の `--allowedTools`（`claude.yml:176`）に `gh` が無く、GitHub API を参照できない（§1.2） |
| 2 | `docs/automation-protocol.md` に何が書かれるべきか | 参照元 workflow は存在するが本文が無い。運用契約の内容は owner の決定事項（§1.3） |
| 3 | ChatGPT Work / Codex 側の現行の役割分担の実態 | このリポジトリからは `allowed_bots`（`claude.yml:163`）以上のことが観測できない |

### 18.2 設計上まだ決めていないこと（意図的な先送り）

| # | 項目 | 決める場所 |
|---|------|-----------|
| 4 | 確定した state code / event code / evidence kind の一覧 | **LCP-1** |
| 4b | `docs/provider-neutral-scan.manifest.json` の normative schema（field 名の確定）。**path・拘束条件・照合規則は §17.2 / §17.3 で決定済み**で、未決なのは schema 記述の形だけ | **LCP-1** |
| 5 | Run/Event Store の実体（file / 埋め込み / 外部）。**依存追加・DB 導入は本フェーズの禁止事項**なので、選択肢の評価も STORE-1 まで先送り | STORE-1 |
| 6 | Quest が run event を受ける経路の具体（既存 namespace 分離の作法は決定済み・§5.3。**供給元が STORE-1 であることは §15.0 で決定済み**、受け口の形が未決） | LCP-3 |
| 7 | ~~汎用 status 表示面の具体~~ → **確定済み**。第 2 面・非 live region・`ORG_ACCEPTED` / `ORG_ABSENT` / `ORG_REJECTED` の閉じた語彙（`org-snapshot-design.md` §4.7、実装は PR #35）。run state の code は LCP-1 後に同じ面へ追加 | 完了 |
| 8 | `org-snapshot-design.md` §4.1〜§4.6 の未決事項 | ORG-PR-1（変更なし） |
| 9 | budget の単位（cost unit の定義） | LCP-1 以降 |
| 10 | lease の TTL と stall threshold の具体値 | STORE-1 |

### 18.3 この文書が置いている前提

- **前提 A**: 現在の Quest の read-only / loopback 境界を将来も維持する。§12.2 はこの前提に立ちます。
  owner がこれを変える判断をした場合、§12 と §15 の後半は再設計が必要です。
- **前提 B**: `org-snapshot-design.md` の設計判断（org snapshot は event stream ではない）は
  有効なまま。§14 はこの前提に立ちます。
- **前提 C**: 利用制限時に自動 retry しない hard stop 方針（`claude.yml:180-182`）を維持する。
  §8.4 はこの前提に立ちます。
