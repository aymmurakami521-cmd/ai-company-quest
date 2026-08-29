# Phase 2 条件1・2 設計記録（org snapshot / 固定roster）

Phase 2の未達条件2つについて、**実装せずに責務境界だけを確定する**ための設計記録です。

| # | 条件 | 現状 |
|---|------|------|
| 1 | 6部署・社長室・未所属・共用施設のフロア構成 | **未実装**（入力契約は確定済み → §4） |
| 2 | 15名の固定着席 | **未実装**（入力契約は確定済み → §4） |

この文書はコードを変更しません。新しいwire schema、API、SSE event、runtime挙動も定義しません。
**新規の内部API名・field名・関数名も決めません**（仮称も置きません）。未実装の要素は役割だけを書き、
名称は§4.1の確認結果と実装PR（§5）で決めます。既存の名称・`file:line` は事実として引用します。
**「既存事実」「設計判断」「未決事項」「次PR候補」を混ぜない**ことがこの文書の目的です。
実装とこの文書が食い違った場合は、常に実装（`src/`）が正です。

関連: [event-contract.md](event-contract.md) / [live-wire-contract.md](live-wire-contract.md) /
[loop-control-plane-design.md](loop-control-plane-design.md)

> **この文書の位置づけ（[loop-control-plane-design.md](loop-control-plane-design.md) による改訂）**
>
> 本文書の設計判断は **破棄されていません**。§5 の PR-1 〜 PR-5 も supersede されず、順序も維持されます。
> ただし新しいロードマップでは Quest を Run State / Event の read model / experience layer として
> 位置づけ直すため、次の1点だけが変わります。
>
> - **§4.7（縮退状態をどの表示面で示すか）の決定は、org 専用ではなく「stream 状態を隠さない、
>   閉じた語彙の第2 status 面」として行うことを推奨します。** run state・承認待ち・stall も同じ
>   表示面を使うため、表示面を2度決めないためです。判断基準（閉じた語彙のみ・自由記述なし・
>   stream 状態を隠さない）は変えません。
> - この推奨により、**§5 PR-1 の §4.7 決定部分**は Run/Event contract の語彙確定（LCP-1）に依存します。
>   §4.1〜§4.6 の外部事実確認は依存せず、並行して進められます。
>
> **PR-1（Issue #23）での解決**: §4.7 は「**表示面の契約**（banner とは別の第2面である・閉じた語彙である・
> stream 状態を隠さない・汎用面として設計する）」までを確定し、**語彙の中身は org 分だけ先に定義**する形で
> 決着させました。run state 側の code は LCP-1 確定後に**同じ面へ追加**します。表示面を2度決めないという
> 本注記の目的は満たしたまま、**PR-3 は LCP-1 の完了を待ちません**。詳細は §4.7。
> - §5 PR-4（決定論的 layout）は Loop Control Plane の前提ではないため、後ろへ移動しても構いません
>   （分割はしません）。
>
> 詳細は [loop-control-plane-design.md §14](loop-control-plane-design.md#14-既存-org-snapshot--roster-ロードマップの移行) を参照してください。

---

## 1. 既存事実

現行main（`7c9da9c`）のコードを読んで確認できる事実だけを書きます。推測は §4 に分離しています。

### 1.1 このrepositoryに org 概念は存在しない

| 事実 | 正本 |
|------|------|
| 席は **collectorが解決したruntime actorの数だけ**存在する。`seat` は並べ替え後のindex+1で、actorが増減すれば番号は変わる | `src/ui/public/quest-view.js:612` `selectDesks` |
| 部署・部屋・フロア・共用施設という区画の概念がない。canvasは**壁1枚と床1枚の単一room**で、`columns × rows` のgridに席を並べるだけ | `src/ui/public/quest-world.js:511` `buildWorld`、`MAX_COLUMNS=6`（:49）、`MAX_ROWS=16`（:73） |
| 固定rosterが無い。誰がいるかはstreamに現れたactorだけで決まり、着任前・退席後の社員という状態を持たない | `src/domain/reducer.ts:230` `reduce`（`state.actors` はevent到着時に作られる） |
| `buildWorld` はorganisation snapshotを入力に取らないことをdoc commentで明言している | `src/ui/public/quest-world.js:5-8` |
| READMEの「既知の制限」が同じことを明記している | `README.md:437-439` |

### 1.2 role は解決されるが、配属は解決されない

| 事実 | 正本 |
|------|------|
| `ActorDirectory = { roles: Record<string, string> }` が唯一のrole供給源。key は `actorKeyOf(session_id, agent_id)` かbareな `agent_id` | `src/domain/actor.ts:40` |
| directoryにも event の `agent_role` にも無ければ `role = null` / `resolved = false`。**fallbackも推測もしない** | `src/domain/actor.ts:78` `resolveActor` |
| `NamespaceStore` は `directory` optionを受け取れる | `src/collector/store.ts:106,146` |
| **`src/live.ts` は `directory` を渡していない**。したがって現行の `npm run live` / `npm run demo` では role は event の `agent_role` 由来のみで、directory由来のroleは実行経路上ゼロ件 | `src/live.ts:29-50` |
| directoryが持つのは role **文字列だけ**。部署、上長、席、在籍期間、社員番号を持つ場所はどこにもない | `src/domain/actor.ts:40-42` |
| `{session_id}:main` は「そのsessionのmain orchestrator」という**構造上の事実のみ**で、CEO等の役職を意味しない | `src/domain/actor.ts:11-12`、`README.md:379-380` |
| `agent.type`（runtime agent type）は組織roleではないため `agent_role` へ入れず、`runtime_agent_type` として別fieldに保持する | `README.md:371-372`、`src/domain/wire.ts:22-26` |

### 1.3 wire に org fieldは1つも無い

`WIRE_EVENT_KEYS`（`src/domain/wire.ts:39`）は19 keyのwhitelistで、
`department` / `desk` / `floor` / `room` / `seat` / `employee_id` に相当するkeyは含まれません。
`toWireEvent` はproducer objectをspreadせずfield単位で組み立てるため、
producerが未知keyを送っても wire には出ません（`src/domain/wire.ts:61`）。

`SanitizedEvent`（`docs/event-contract.md` の Keys表）にも org fieldはありません。

### 1.4 snapshot が運ぶもの

`GET /events/{live,demo}` の `snapshot` control frameは `state: store.state`、すなわち
`QuestState` 全体をそのまま載せます（`src/server/server.ts:251-267`）。
`QuestState` は `namespace` / `player` / `limits` / `sessions` / `actors` /
`last_ingest_seq` / `counters` の7 fieldです（`src/domain/reducer.ts:113`）。
**org snapshotを載せる枠は現状ありません。**

### 1.5 人間playerは既にeventから分離済み（PR #15の成果）

| 事実 | 正本 |
|------|------|
| `player` は `QuestState` のfieldだが、`reduce` はこれをreferenceのまま持ち回り、**どのeventも書き換えられない** | `src/domain/reducer.ts:336-337` |
| playerの値は `QUEST_PLAYER_NAME` から1人だけ作られる | `src/live.ts:27`、`src/config.ts:46-47` |
| playerは `Desk` ではない。席番号も `actor_key` も session も持たず、社員一覧・在席数・選択の対象外 | `src/ui/public/quest-view.js:673` `selectPlayer` |
| canvasではgridの外の専用stripに立ち姿で描かれ、`world.actors` に入らない | `src/ui/public/quest-world.js:633-660`、`:701` |

**この分離パターンが条件1・2の設計の下敷きです**（§2参照）。「eventが作る世界」と
「eventが作らない世界」を別の入力・別のprojection・別のrenderingとして扱う、という点が既に成立しています。

### 1.6 上限とfail-closed

| 事実 | 正本 |
|------|------|
| `DEFAULT_STATE_LIMITS` = `max_sessions:512` / `max_actors:4096` / `max_actors_per_session:256` / `max_event_types:64` | `src/domain/reducer.ts:98` |
| 上限超過は silent eviction ではなく **ingest halt**（fail closed）。`halt_reason` は `state_limit:<上限名>:<値>` でstream内容を含まない | `src/domain/reducer.ts:134` `StateLimitExceededError`、`README.md:347-357` |
| bannerは閉じた語彙で、常にちょうど1 codeが表示される | `src/ui/public/quest-view.js:712` `BANNER_CODES`、`README.md:202-211` |
| canvasは上限超過分を黙って落とさず、`表示 N 枠 / 全 M 枠 · 残り K 枠は下の一覧に表示` を出す（区画が溢れれば `区画 N / M`、未描画に注意状態があれば `未描画に ✖ ERROR あり` も付く）。DOM側は常に全**枠**を表示する（集約席の非代表actorは人数のみ） | `src/ui/public/quest-world.js:484` `overflowTextFor`、`README.md:250-254` |

---

## 2. 設計判断

ここから先は**この文書が提案する責務境界**です。コードにはまだ存在しません。

### 2.1 中心となる判断: org snapshot は event stream ではない

固定rosterと部署構成は、**Claude Code sessionのevent streamからは導けない事実**です。
これを event 経路に載せると次が壊れます。

- `reduce` の純粋性 —— 「eventが作らないもの」がeventに依存し始める
- fail-closedの意味 —— 15名の社員が「まだeventを出していない」だけでhaltするか、逆に推測で着席する
- 決定論 —— 席番号がstreamの到着順で動く（現状の `seat` はまさにこれ）

したがって **§1.5 の player と同じ構造**を採ります。

```
[event stream]                  [org snapshot]                    [human player]
sanitized JSONL                 静的設定 (未決 §4)                QUEST_PLAYER_NAME
   ↓ validate/adapter              ↓ 読み取り1回                     ↓ 起動時1回
   ↓ reduce (pure)                 ↓                                 ↓
state.actors / state.sessions   検証済みorg snapshotの保持先        state.player
                                (QuestStateの独立field・新規)
   ↓                               ↓                                 ↓
selectDesks()                   org snapshotのprojection層          selectPlayer()
                                (新規)
   ↓                               ↓                                 ↓
        buildWorld() ── 3入力を合成して1つのWorldにする
```

**3つは合流地点まで混ざらない。** 合流するのはprojection層（`buildWorld`）だけで、
reducerでは合流しません。

図の左右列は既存実装の名称です（§1）。中央列は**役割だけ**を示します。
**新規要素のfield名・関数名・schema・DOM構造はこの文書では決めません**（仮称も置きません）。
入力形式は§4.1の確認結果に依存し、名称は実装PR（§5 PR-2 / PR-3）で決めます。

### 2.2 責務の割り当て

| 層 | 責務 | 責務**でない**もの |
|----|------|------------------|
| ai-company側 `company/org.yaml`（**外部repo・未確認 §4.1**） | 部署・社員・配属の正本 | 席座標、描画、runtime状態 |
| Quest collector | org snapshotを**そのまま**読み取り、検証して `QuestState` の独立fieldへ置く（field名は実装PRで決める） | org情報の合成・補完・推測、eventからのorg導出 |
| `reduce`（`src/domain/reducer.ts`） | org snapshotの保持fieldに**触らない**（`player` と同じくreferenceで持ち回る） | org snapshotの保持fieldの更新 |
| projection（`quest-view.js`） | actor（動的）と roster（静的）の**突き合わせ**。突き合わない側はそのまま公開する | 突き合わせ失敗の穴埋め |
| layout（`quest-world.js`） | roster順から決定論的に座標を決める | 誰がいるかの判断 |
| canvas（`quest-canvas.js`） | 渡された矩形を塗るだけ | 一切の判断 |

### 2.3 突き合わせ規則（設計判断）

roster社員とruntime actorは**別物**であり、対応は3通りしかありません。

| 状況 | 扱い | 理由 |
|------|------|------|
| roster社員に対応actorがある | 在席・状態あり | — |
| roster社員に対応actorが**無い** | 席は存在し、状態は「不在」。**捏造しない** | 固定rosterは「席がある」ことの正本であり、「働いている」ことの正本ではない |
| actorに対応roster社員が**無い** | 未所属エリアに置く。roster側を書き換えない | eventは正本。消すとstreamの事実と食い違う |

3番目が条件1の「未所属」の存在理由です。未所属は「エラー時の置き場」ではなく、
**roster外actorの正規の居場所**として設計します。

### 2.4 安全境界（この設計で緩めないもの）

- org snapshotは **read-only / 起動時読み取り**。runtimeで書き換えるendpointを作らない
- org snapshotの中身も `src/domain/validate.ts` と同等の禁止内容checkを通す（絶対path・credential・shell断片）
- org snapshotの検証失敗は **fail closed**。部分適用も推測補完もしない（§3の停止条件表）
- **縮退は必ず可視化する。** org snapshotが不在・拒否のまま現行表示へ縮退した事実を利用者へ示せない状態を作らない。
  したがって **org-backed UIは、縮退状態を閉じた語彙で示す表示契約と同じPR以降でのみ有効化する**（順序制約 → §5）。
  表示契約が入るまでは、読み取り・検証・状態保持まで実装してもUIはorg非対応のまま据え置く
- org snapshotの保持fieldにも明示上限を置き、`DEFAULT_STATE_LIMITS` と同じくstateが持つ（bounded memory）
- 拒否理由は field名 + rule名のみ。社員名・部署名をhalt reasonへ入れない
- LIVE/DEMO分離は不変。org snapshotも namespace ごとに独立したinstanceとする
- loopback-only、CORS header無し、Host allowlist、`textContent` 経由のみのDOM挿入は不変

---

## 3. 条件別の契約表

### 3.1 条件1: 6部署・社長室・未所属・共用施設

| 項目 | 内容 |
|------|------|
| authoritative source | ai-company側の **検証済みスナップショット `company/org.snapshot.json`**（**実在・形式ともに確認済み → §4.1**）。社長室だけは org 定義に無く、player 由来で扱う（§4.1） |
| 必要入力 | 区画の**識別子と順序**のみ。部署id、表示名、区画種別（部署 / 社長室 / 未所属 / 共用施設）、並び順 |
| 入力に**含めない**もの | 座標、pixel、幅、色。layoutはQuest側が決める（§2.2） |
| consumer | ① org snapshotのprojection層（新規・未実装。関数名は決めない）が区画一覧を projection する ② `buildWorld()` が区画ごとにroom矩形を割り当てる ③ DOMの社員一覧が区画ごとにgroup化する |
| DOM/canvasの正本関係 | **不変**: DOMが正本、canvasは `aria-hidden` の装飾層（`README.md:271-273`）。区画名・所属はDOM側にも必ず出る |
| fail-closed時の挙動 | org snapshotが読めない / 検証に落ちる → **org機能を持たない現行の単一room表示へ縮退**し、閉じた語彙で明示。部分的な区画を描いたり、欠けた部署を推測で補ったりしない。event ingestはhaltさせない（org不在はstreamの健全性と無関係）。**この明示が実装される前にorg-backed UIを有効化しない**（§2.4の順序制約・§5） |
| 決定論的layout | 区画の描画順は**snapshotの宣言順のみ**で決める。hash・時刻・乱数・actor数を使わない。同じsnapshot + 同じviewport → 同じ座標 |
| 上限 | 区画数に明示上限を置く。超過時はsilent truncateではなくorg読み込みを拒否（§2.4） |
| 検証方法 | ① 同一snapshot・同一viewportで `buildWorld` の全矩形が bit-for-bit 一致 ② 区画矩形が互いに重ならず room内に収まる ③ org snapshot欠落時に単一room表示へ縮退し、**その事実が閉じた語彙で表示される**（無言の縮退が無い） ④ 区画名が canvas だけでなく DOM にも出る ⑤ 検証失敗時に社員名・部署名がhalt reasonへ漏れない |

### 3.2 条件2: 15名の固定着席

| 項目 | 内容 |
|------|------|
| authoritative source | 同上の snapshot の `roles[]`（**確認済み: 15件 → §4.1**）。15という数はrosterの結果であって、**定数として焼き込まない**（§4.3） |
| 必要入力 | 社員ごとに: 安定した社員識別子、表示名、所属区画id、区画内の並び順、runtime actorとの照合key |
| 照合key | **`runtime_agent_type`（確認済み → §4.2）**。wire の19 keyに既に存在し（`src/domain/wire.ts:49`）、`hookAdapter.ts:205` が `wire.agent.type` から載せ、ai-company 側 `roles[].runtime_agent_type` と対になる。bare `agent_id` ではない。`session_id` は照合に使わない |
| consumer | ① roster projection（新規・未実装。関数名は決めない） ② `selectDesks` 相当が roster席 × actor状態を突き合わせる ③ `buildWorld` がroster順から席座標を決める |
| 席番号の意味の変更 | 現行 `seat` は「並べ替え後のactor index+1」（`quest-view.js:640-643`）で**動く**。固定着席では席はrosterに属し、actorの増減で動かない。これは既存の `seat` の意味を変えるため、置き換えではなく**別fieldとして導入**すべき（§4.4） |
| fail-closed時の挙動 | roster不在・検証失敗 → **現行の動的着席へ縮退**し、閉じた語彙で明示。roster社員を推測で生成しない。1件でも不正なら部分適用せずroster全体を不採用にする（部分rosterは「誰がいないのか」を誤って伝えるため）。**この明示が実装される前にroster-backed UIを有効化しない**（§2.4の順序制約・§5） |
| 未対応actorの扱い | roster外actorは未所属区画へ（§2.3）。**捨てない**。捨てるとstreamの事実と表示が食い違う |
| 対応actor不在のroster社員 | 席は描き、状態は「不在」。`active`・`status`・`last_tool` を捏造しない。playerと同じく「eventが作らない存在」として扱う |
| 決定論的layout | 席座標は `(区画の宣言順, 区画内のroster順)` の2段のみで決まる。actorの有無・到着順・hashを座標に混ぜない。同じroster + 同じviewport → 同じ座標。人物の外見は現行どおり安定key由来（`quest-world.js:204` `appearanceFor`） |
| 上限 | roster人数に明示上限。`max_actors`（4096）とは別の上限で、org側の上限に到達したらorg読み込みを拒否（ingest haltではない） |
| 検証方法 | ① 同一rosterで席座標が bit-for-bit 一致 ② actorが0名でも全roster席が描かれる ③ actorが増減しても既存roster席の座標が動かない ④ roster外actorが未所属区画に出て消えない ⑤ 対応actor不在の社員に状態が捏造されない ⑥ player（`selectPlayer`）が roster席・在席数・選択のいずれにも入らない（既存testの不変を維持） ⑦ roster拒否時に動的着席へ縮退した事実が閉じた語彙で表示される（無言の縮退が無い） |

---

## 4. 確認結果（旧: 未決事項）

**PR-1（Issue #23）で §4.1〜§4.6 を実物に対して確認しました。** 以下は推測ではなく観測した事実です。
観測日: 2026-08-28 / 観測対象: `ai-company` repository（このrepositoryの外部）。

観測時点の値の同定子:

| 項目 | 値 |
|------|-----|
| `org_definition_hash` | `sha256:5b65bf110d6e19dbd…` |
| `agent_definitions_hash` | `sha256:09000ad8da7c6d8b8…` |
| `validation_warnings` | `[]`（0件） |

> **hash は「観測した版」を同定するためだけに引用しています。**Quest 側がこの値を定数として
> 焼き込むことは意図していません（§4.3）。

### 4.1 ai-company側 `company/org.yaml` の実在と形式 — **確認済み**

**実在します。** 加えて、Quest が読むべき対象は yaml 本体ではなく**検証済みスナップショット**です。

| 確認項目 | 観測した事実 |
|---|---|
| file の実在 | `company/org.yaml`（定義の正本・人間が編集する）、`company/org.schema.json`（検証schema）、`company/org.snapshot.json`（**検証済みスナップショット**）の3点が実在 |
| 生成経路 | `scripts/validate_org.py --check`（検証）/ `--emit`（snapshot 生成）。生成物の drift は `scripts/check_artifacts.py` が一括検査する |
| 部署 | **6件**（`dept-development` / `dept-automation` / `dept-pm-consulting` / `dept-sales-strategy` / `dept-content` / `dept-finance`）。各件に `display_order`（10〜60・重複なし） |
| 社員（役職） | **15件**。内訳は `executive` 4 / `staff` 1 / `department` 6 / `assistant` 4 |
| 共用施設 | **7件**、すべて `type: "shared"`（`skill-workshop` / `meeting-room` / `artifact-gallery` / `external-gateway` / `scheduler-room` / `ops-dashboard` / `security-zone`） |
| 社長室 | **org定義には存在しません。**社長／CEO「歩」は Human（Player）であり Agent 定義を持たないため、`roles` に登録されていません（`company/org.yaml` 冒頭コメントに明記） |
| 安定した識別子 | あります。`roles[].id` / `departments[].id` / `facilities[].id`。値域は `^[a-z0-9][a-z0-9-]{0,63}$`（`org.schema.json` `#/$defs/identifier`）。15件すべてがこの文法に一致することを確認済み |
| 表示名 | `displayName` = 1〜100文字。**日本語を含みます**（`開発部` / `Skill工房` 等） |
| `roles[].kind` | 閉じた列挙 `executive` / `department` / `staff` / `assistant` |
| 所属 | `roles[].department_id`。**非nullは6件のみ**（`department` kind だけ）。`executive` / `staff` / `assistant` は `null` = 部署に属さない |
| 参照整合性 | `roles[].department_id` の集合が `departments[].id` の集合と一致することを確認済み |

**条件1の「社長室」と「未所属」について（重要）**

- **社長室は org 定義から作れません。**歩は `roles` に存在しないため、社長室区画を org snapshot から
  projection することはできません。Quest 側は歩を既に `state.player` として event から分離して
  保持しています（§1.5）。したがって社長室は **org snapshot 由来ではなく player 由来の区画**として
  扱う必要があります。これは §3.1 の入力契約の想定と異なるため、**PR-4 の layout 設計で
  区画種別「社長室」の供給元を player 側に読み替えます**（この読み替え自体が PR-1 の確認成果です）。
- **「未所属」は org 定義に区画として存在しません。**存在するのは `department_id: null` の役職 9件
  （executive 4 / staff 1 / assistant 4）です。「未所属」区画は **Quest 側が projection で作る器**であって、
  org 側の宣言ではありません。§2.3 の「roster外actorを未所属へ」という規則は維持しつつ、
  **`department_id: null` の roster 社員も同じ器に入る**ことを PR-3 の実装契約に含めます。

### 4.2 roster社員 ↔ runtime actor の照合key — **確認済み（設計記録の想定を訂正）**

**bare `agent_id` ではありません。照合keyは `runtime_agent_type` です。**

§3.2 は「成立するのはbare `agent_id` 側だけに見える」と書いていましたが、これは誤りでした。
実際には**専用の照合fieldが既に wire 上に存在し、両端で繋がっています**:

| 層 | 事実 |
|---|---|
| ai-company `org.snapshot.json` | `roles[].runtime_agent_type` を持つ。値は Agent frontmatter の `name` の**実値**から補完される（手入力は禁止・`org.yaml` 冒頭コメント） |
| ai-company emitter | `scripts/quest-hook-emit.py` が `agent.type` に `agent_type` をサニタイズして載せる。同 file のコメントが「downstream の照合（`runtime_agent_type` との突き合わせ）」を明示している |
| Quest hook adapter | `src/domain/hookAdapter.ts:205` — `runtime_agent_type: wire.agent.type` |
| Quest wire | `runtime_agent_type` は19 keyのうちの1つ（`src/domain/wire.ts:26,49,74`） |
| Quest validator | `src/domain/validate.ts:188-189` が `LABEL_SLUG` で検証する nullable label として受理 |

**文法の互換性を機械的に確認済み**（観測時点の15件すべて）:

- 15件の `runtime_agent_type` すべてが Quest の `LABEL_SLUG` (`^[A-Za-z0-9_.:@#| -]{1,128}$`) に一致
- 15件すべてが `ID_SLUG` にも一致
- 15件の `runtime_agent_type` は**一意**
- 観測時点では全件で `roles[].id` と `runtime_agent_type` が同値だが、**これは偶然であり同一視しない**
  （前者は org 定義の識別子、後者は Agent 定義の実値で、供給元が別）。照合には必ず
  `runtime_agent_type` を使う

**`session_id` は照合に使いません。**固定 roster は特定 session に属さないためです。
`ActorDirectory` の scoped key はそのまま runtime 側の同定に使い続け、roster との突き合わせだけを
`runtime_agent_type` で行います。

**同一社員が複数 session で同時に動く場合 — 設計判断: 1席に集約する。**
roster の席は「社員」に属し session には属しません。同一 `runtime_agent_type` を持つ actor が
複数在席する場合、席は1つのまま、その席の状態は**在席中の actor 群から決定論的に決めます**
（決め方の規則は PR-3 の実装範囲）。席を session 数だけ増やすと「15名固定着席」が壊れるため採りません。
roster 外 actor は従来どおり未所属区画へ置き、捨てません。

### 4.3 「15名」「6部署」を定数として持つか — **設計判断: 持たない**

観測時点では 15名 / 6部署 / 7施設ですが、**org 定義側にこの件数を固定する仕組みはありません**
（`org.schema.json` に件数の下限・上限はなく、`departments` / `roles` は可変長配列）。
したがって「15」「6」は**rosterの結果**であり、Quest 側の定数にしません。

条件が満たされたことの検証は、件数の定数比較ではなく**取り込んだ snapshot 自身に対する不変条件**で行います
（例: 全 roster 社員に席がちょうど1つ / 席座標が roster 順から決定論的 / actor 増減で既存席が動かない）。
「15名着席」は、観測した snapshot を fixture として使った時にちょうど15席になることを示す
**回帰 test** として表現します（定数の焼き込みではなく fixture に対する事実）。

### 4.4 現行 `seat` field の後方互換 — **設計判断: 別fieldとして導入し、`seat` の意味は変えない**

`Desk.seat`（`src/ui/public/quest-view.js:643`）は「並べ替え後の actor index+1」のまま据え置きます。
固定着席の席番号は**別 field** として導入します（field名は PR-3 / PR-4 の実装範囲）。

並存期間の扱い — **設計判断**: org snapshot が採用されていない間は現行 `seat` のみが意味を持ち、
採用された後は両方が存在します。`normalizeDesk`（`quest-world.js:492`）と `test/ui-world.test.ts` の
既存前提は変更しません。**片方だけを見て他方を推測することを禁止**し、どちらの field も
「無ければ無い」として扱います（欠損を index で補完しない）。

### 4.5 org snapshotの供給経路 — **設計判断: 設定由来のpathのみ。新しい環境変数を1本増やす**

現行の `QUEST_INPUT_PATH` と同じ境界を維持します（**event 内容から path を組み立てない**・
`README.md:376`）。org snapshot も**設定由来の path からのみ**読み、既定は「未設定 = org機能なし」です。

- 環境変数を**1本**追加する（変数名は PR-2 の実装範囲。この文書では固定しません）
- **cross-repository の固定 path を焼き込みません。**`ai-company` の位置を Quest が知っている前提を作らない
- 読むのは `company/org.yaml` ではなく **`company/org.snapshot.json`**（検証済みスナップショット）です。
  yaml parser を Quest に持ち込まず、`ai-company` 側の検証（`validate_org.py`）を経た成果物だけを受けます。
  これは「Quest は組織の意味を発明しない」（§2.1）と一致します
- 未設定 / 読めない / 検証に落ちる → **org機能のみ無効**（現行表示へ縮退）。**ingest は halt させません**

### 4.6 LIVE/DEMO それぞれのorg snapshot — **設計判断: DEMOは組み込みfixture、LIVEは設定path**

DEMO の不変条件（固定 event・timer なし・乱数なし・**外部I/Oなし**・`README.md:80-81`）を維持するため、
DEMO で file を読むことはしません。

- **DEMO**: 組み込みの org fixture を使う（`src/demo/fixtures.ts` と同じ扱いの静的データ）。
  これにより DEMO だけで区画・固定着席・縮退表示のすべてを再現できます
- **LIVE**: §4.5 の設定 path のみ。未設定なら org 機能なしで動作する
- **DEMO state が LIVE へ混ざらない不変条件（`README.md:302-310`）は維持します。**
  DEMO fixture は LIVE 保存領域へ書かず、LIVE 経路は DEMO fixture を参照しません

### 4.7 縮退状態をどの表示面で示すか — **設計判断: bannerとは別の、閉じた語彙の第2 status面**

既存 banner は**常にちょうど1 code**だけを表示します（`src/ui/public/quest-view.js:712` `BANNER_CODES`、
`README.md:202-211`）。org 縮退を既存 banner の語彙に足すと、org 側の code が
`FAIL_CLOSED` / `DISCONNECTED` を押しのけて **stream 異常を隠す**ため、採りません。

**採用: banner とは別の、閉じた語彙の第2 status 表示面を置く。**

- 判断基準は維持: **閉じた語彙のみ・自由記述なし・stream 状態を隠さない**
- 第2面は org 専用ではなく**汎用の第2 status 面**として設計します
  （[loop-control-plane-design.md](loop-control-plane-design.md) §14 の推奨と一致）。
  将来 run state・承認待ち・stall が同じ面を使えるようにし、表示面を2度決めません
- **LCP-1 との関係（重要）**: 本文書冒頭の改訂注記は §4.7 の決定を LCP-1 の語彙確定に依存させていました。
  ここでは**表示面の存在と契約**（第2面である・閉じた語彙である・banner を隠さない）までを確定し、
  **語彙の中身は org 分だけ先に定義**します。run state 側の code は LCP-1 確定後に同じ面へ追加します。
  これにより PR-3 は LCP-1 を待たずに着手できます
- 具体的な code 名・文言・DOM 構造は **PR-3 の実装範囲**です（この文書では決めません）

---

## 5. 次PR候補

前後関係のある順に並べています。**PR-1 が完了するまで PR-2 以降は着手できません**（§4.1）。

**順序制約（§2.4）**: org-backed UIを有効化するPRは、縮退を閉じた語彙で示す表示契約を
**同じPRで**必ず含みます。表示契約が入るまでは、org snapshotを読み・検証・保持していても
UIはorg非対応のまま据え置き、無言の縮退状態を作りません。

### PR-1: org定義の事実確認と入力契約の確定（分類A: docs のみ）— ✅ **完了**（Issue #23）

**§4 が「未決事項」から「確認結果」に変わりました。**§4.1〜§4.6 は `ai-company` の実物に対する
観測結果、§4.7 は現行 `BANNER_CODES` の事実に基づく設計判断です。PR-2 の着手条件は満たされています。

主要な確認結果（詳細は §4）:

| # | 結論 |
|---|---|
| 4.1 | 実在。読む対象は `company/org.snapshot.json`（検証済み）。**6部署 / 15役職 / 7共用施設**。**社長室は org 定義に無い**（player 由来で扱う）。「未所属」は Quest 側が作る器 |
| 4.2 | 照合keyは **`runtime_agent_type`**（bare `agent_id` ではない）。wire に既存・両端で接続済み・15件すべて文法互換を機械確認 |
| 4.3 | 件数は定数にしない。fixture に対する回帰 test で表現する |
| 4.4 | `seat` の意味は変えず、固定席番号は別 field |
| 4.5 | 設定由来 path のみ。環境変数を1本追加。cross-repo の固定 path は焼き込まない |
| 4.6 | DEMO は組み込み fixture（外部I/Oなし）、LIVE は設定 path |
| 4.7 | banner とは別の**汎用の第2 status 面**。表示面の契約までを確定し、語彙は org 分から始める（LCP-1 を待たない） |

- **前提**: なし
- **成果契約**: §4.1〜§4.7 の未決事項に対する**確認結果**をこの文書へ追記する。org定義が実在するなら、そのkeyと値域を「観測した事実」として記録する。§4.1〜§4.6 は外部事実の確認、**§4.7 は事実確認（現行 `BANNER_CODES` が単一codeであること）に基づく設計判断**で、「既存bannerの語彙を1増やす / 別の閉じた語彙のstatus面を置く」のどちらを採るかと、その判断基準（閉じた語彙のみ・自由記述なし・stream状態を隠さない）をこの文書で確定する
- **対象外**: schema定義、code変更、環境変数追加、**新規のfield名・関数名**（PR-2 / PR-3の実装範囲）、**§4.7で採る側の具体的なcode名・文言・DOM構造**（PR-3の実装範囲）
- **完了判定**: §4.1〜§4.7 の未決事項がすべて「確認済み」「設計判断済み」「実在しないため対象外」のいずれかに変わっている
  → **達成**（§4 参照）

### PR-2: org snapshot読み取りと検証（分類B: code、runtime影響あり）— ✅ **完了**（PR #27・上限修正 #33）

- **前提**: PR-1 → ✅ **充足済み**
- **成果契約**: org snapshotを読み、`src/domain/validate.ts` と同等の禁止内容checkを通し、検証失敗時はfail closed（org機能のみ無効、ingestはhaltさせない）。`QuestState` へ**独立fieldとして**置く（**field名はこのPRで決める**。この文書では固定しない）。`reduce` は触らない。あわせて **採用 / 不在 / 拒否のいずれであるかを閉じた語彙で読み取れる状態**を同じ独立fieldに保持する（拒否理由は field名 + rule名のみ・§2.4）。表示面の選択は§4.7の結論に従う
- **対象外**: UI（org非対応の現行表示のまま据え置く）、layout、wire schema変更、SSE frame追加
- **完了判定**: 不正なsnapshotが1件でもあればorg全体を不採用にするtestが通る。採用/不在/拒否の状態が閉じた語彙で読めるtestが通る。既存のingest系testが全て不変。**UIの描画結果が現行と一致する**（このPRではorg-backed UIを有効化しない）

### PR-3: roster projection と突き合わせ ＋ 縮退表示（分類B: code、UI影響あり）— ✅ **完了**（PR #35）

**最初のorg-backed UI consumerであるため、縮退表示契約をこのPRに同梱します**（§2.4順序制約・§4.7）。

- **前提**: PR-2（§4.7 の決定は PR-1 で確定済み → 第2 status 面。**LCP-1 の完了を待ちません** — §4.7）
- **成果契約**: §2.3 の3規則を純粋関数として実装（**関数名・DOM構造・表示codeはこのPRで決める**。この文書では固定しない）。対応actor不在のroster社員に状態を捏造せず、roster外actorを未所属へ置く。DOM側の社員一覧に区画groupingを反映。**同時に**、PR-2が保持する採用/不在/拒否の状態を閉じた語彙で表示し、org非採用時は現行表示へ縮退したことを利用者へ示す。stream側の状態表示を隠さない
- **対象外**: canvas layout、席座標、自由記述メッセージ
- **完了判定**: §3.2 の検証方法 ④⑤⑥⑦ と §3.1 検証方法 ③ が通る。org拒否時に無言で現行表示へ落ちるcaseがtestで再現できない

### PR-4: 決定論的な区画layoutと固定席座標（分類B: code、描画影響あり）— ✅ **完了**（PR #37）

- **前提**: PR-3
- **成果契約**: `buildWorld` に区画room矩形とroster席座標を追加。actorの有無で座標が動かない。DOM正本 / canvas装飾層の関係は不変
- **対象外**: 操作、選択、pointer hit test（Phase 3の範囲）
- **完了判定**: §3.1 検証方法 ①②、§3.2 検証方法 ①②③ が通る

### PR-5: 縮退経路の最終整合とREADME更新（分類A: docs 中心）— **実施中**

縮退表示そのものはPR-3で入っているため、このPRは**文書と実態の突き合わせ**に縮小します。

- **前提**: PR-4
- **成果契約**: PR-3で入った縮退表示の語彙と挙動をREADMEへ記載し、「既知の制限」（`README.md:437-439`）と本文書を実態に合わせて更新する。canvas layout追加後（PR-4）も縮退経路が変わっていないことを確認する
- **対象外**: 新しい表示状態の追加、新しい自由記述メッセージ（表示は閉じた語彙のまま）
- **完了判定**: READMEに未実装と書かれたままの項目が残らず、本文書の未決事項（§4）に確認済みの項目が残らない

---

## 5.1 実装された仕様（PR-2〜PR-4 の結果）

**この節は実装の記録であり、新しい要件ではありません。** §2〜§4 の設計判断のうち、
実装で具体名が確定したものと、レビューで是正されたものを事実として残します。
食い違った場合は常に実装（`src/`）が正です。

### 語の区別（数え間違いの原因になったもの）

| 語 | 意味 | 数えるもの |
|---|---|---|
| **actor** | runtime の実体。`(session_id, agent_id)` で識別 | **在席数はこれ** |
| **session** | 1回の実行。1 session が複数 actor を持ちうる | 在席数ではない |
| **固定席 / seat** | roster 社員に属する席。**1席に複数 actor が座りうる** | 席数。actor 数と一致しない |
| **枠 / desk** | 画面に描く1カード / セル | 描画数。overflow の分母 |

実装中に3度、この3語の間を滑って誤った（PR #37 のレビュー 2〜4 巡目）。
**在席数は actor 数**で、DOM header と canvas HUD は同じ数を出す。

### roster projection（§2.3 の3規則）

- 照合keyは **`runtime_agent_type` のみ**。`agent_id` / `session_id` は使わない
- 対応 actor のいない roster 社員 → **席は描き、状態は出さない**（`不在`）。
  `status` / `last_tool` / `last_event_ts` / `session_id` / `role` はすべて null
- roster 外 actor → **未所属へ置く。捨てない**
- `department_id` が null の roster 社員も未所属の器へ入る（§4.1）

### 同一 key の複数 actor（§4.2 の集約）

- 席は **1つのまま**。session ごとに増やさない
- 席が代表として表示する状態は、**在席 actor 群の中で最も注意を要するもの**。
  順位は `ACTOR_VISUAL_STATES` の並び（`error` → `awaiting_approval` → `planning` →
  `working` → `ended` → `idle`）で、同順位は既存の office 順で解決する。
  **終了した古い run が、失敗中の新しい run を覆い隠してはならない**
- 席は代表 actor の `display_name` を保持し、roster 名は `role_name` として**併記**する。
  片方を他方で上書きしない（canvas / 詳細pane と食い違うため）
- 何 actor を代表しているかは常に表示する（カードの `actors` 行）

### 第2 status 面（§4.7）

- banner とは**別**の面。`BANNER_CODES` は拡張しない
- 語彙は org 分のみの閉じた3値: `ORG_ACCEPTED` / `ORG_ABSENT` / `ORG_REJECTED`
- **live region にしない**（banner がページ唯一）
- `grouped === !degraded` を不変条件とし、無言の縮退を表現できなくする
- `accepted` だが client が使えない場合は `absent` ではなく **`rejected`**。
  両者は読み手にとって別の意味であり、混ぜることが §2.4 の禁じる無言の縮退そのもの
- 拒否の内訳は **field名 + rule名のみ**。文法に一致しない `field` は `snapshot` へ落とす

### 区画（zone）

- 種別は **社長室 / 部署 / 未所属 / 共用施設** の4つ。順序はこの通りに固定
- 社長室は org 定義に無く **`state.player` 由来**（§4.1）。席を持たない
- 共用施設は `facilities` 由来。**部屋であって席を持たない**
- **zone id は kind で名前空間化**する（`dept:` / `facility:` / `zone:`）。
  departments と facilities は upstream で同一の識別子空間を共有し、`unassigned` も
  正当な department id なので、prefix が無いと1つの role bucket が2 zone に渡り
  要素が alias される（実際に踏んだ）
- org の `facilities` と、hook wire の runtime `activity.facility`（会議室・カフェ等の
  **現在地**）は**別概念**。混ぜない

### 決定論的 layout（§3.1 / §3.2）

- 席座標は **`(区画の宣言順, 区画内のroster順)`** の2段だけで決まる
- **grouped の列数は roster だけから決める。** actor 数にも viewport 幅にも依存させない
  （どちらかに依存すると、roster外 actor の増減や resize で全 band が再flowする）
- **viewport が変えるのは pixel の大きさだけ**で、論理配置（どの部屋の何行何列か）は
  変えない。room が高くなれば scale は縮むので pixel は動く — 動いてはいけないのは配置
- grouped の room は **viewport 高の2倍を scale の目標 budget** にする（全部屋を1画面に
  押し込むと scale が潰れて読めなくなるため）。**これは上限ではない**: `snapScale` が
  `MIN_SCALE` で止まるので、それ以上縮めないと収まらない大きさになると scale の縮小が
  止まり、room は budget を超えて伸びる。読めない状態で収めるより、読める状態で
  スクロールさせる方を採るという判断。実測で 240px 高・32区画では `MIN_SCALE` に達し、
  room は viewport の4倍を超える。**どんな場合でも効く上限は backing store 側**

### 描き切れないものの扱い

- 席が溢れた場合も、**部屋が溢れた場合も**明示する。部屋だけが溢れて席が溢れていない
  ケースも表示条件に含める（片方だけだと silent truncate になる）
- 上限を超えた区画の**席も** total / hidden / 最悪状態の集計に入れる。
  描けないことと無いことは別
- 件数だけでなく、**描けなかった中で最も注意を要する状態**を出す。
  区画の輪郭と overflow 行をその状態色で描く

---

## 6. この文書の対象外

- org snapshot / roster / Run State Read Model の**実装**
- wire schema、API、SSE event、runtime挙動の変更
- Phase 3（操作API、指示送信、歩行・自由移動、音声入力）
- workflow、permissions、hooks、settings、Secrets、依存追加
- 無関係なrefactor
- **Cost Governance / ROI**（→ [cost-governance-roi-design.md](cost-governance-roi-design.md)）

---

## 7. 関連文書との依存関係

| 文書 | 本文書との関係 |
|------|----------------|
| [loop-control-plane-design.md](loop-control-plane-design.md) | 上位の architecture 設計。本文書の PR-1〜PR-5 は **supersede されず、順序も維持**されます |
| [cost-governance-roi-design.md](cost-governance-roi-design.md) | Cost Governance / ROI の設計記録。**本文書の §4.1（`company/org.yaml` の実在）と §4.2（照合key）に依存しません** — cost の必須帰属軸は論理 role であり、恒久的な社員 identity を要求しないためです（同文書 §5.2）。したがって org 側の未決が cost 側を止めることはなく、逆に cost 側が本文書の未決を先に決めさせることもありません |

**依存の向きを明示しているのは、片方の未決事項がもう片方の着手を不必要に塞ぐことを防ぐためです。**
org 定義の外部事実確認（§4.1）と、cost の attribution contract は**並行して進められます**。
