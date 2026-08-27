# Phase 2 条件1・2 設計記録（org snapshot / 固定roster）

Phase 2の未達条件2つについて、**実装せずに責務境界だけを確定する**ための設計記録です。

| # | 条件 | 現状 |
|---|------|------|
| 1 | 6部署・社長室・未所属・共用施設のフロア構成 | **未実装** |
| 2 | 15名の固定着席 | **未実装** |

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
| canvasは上限超過分を黙って落とさず、`表示 N 席 / 全 M 席 · 残り K 席は下の一覧に表示` を出す。DOM側は常に全actorを表示する | `src/ui/public/quest-world.js:484` `overflowTextFor`、`README.md:250-254` |

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
| authoritative source | ai-company側の org 定義（`company/org.yaml` 想定。**実在・形式ともに未確認 → §4.1**） |
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
| authoritative source | 同上のorg定義の社員roster（**未確認 → §4.1**）。15という数はrosterの結果であって、**定数として焼き込まない**（§4.3） |
| 必要入力 | 社員ごとに: 安定した社員識別子、表示名、所属区画id、区画内の並び順、runtime actorとの照合key |
| 照合keyの候補 | `ActorDirectory` のkey体系（`actorKeyOf(session_id, agent_id)` またはbare `agent_id`、`src/domain/actor.ts:40`）を**そのまま流用する**のが既存事実に最も近い。ただし `session_id` はrun毎に変わるため、固定rosterが持てるのは実質bare `agent_id` 側のみ → **§4.2 未決** |
| consumer | ① roster projection（新規・未実装。関数名は決めない） ② `selectDesks` 相当が roster席 × actor状態を突き合わせる ③ `buildWorld` がroster順から席座標を決める |
| 席番号の意味の変更 | 現行 `seat` は「並べ替え後のactor index+1」（`quest-view.js:640-643`）で**動く**。固定着席では席はrosterに属し、actorの増減で動かない。これは既存の `seat` の意味を変えるため、置き換えではなく**別fieldとして導入**すべき（§4.4） |
| fail-closed時の挙動 | roster不在・検証失敗 → **現行の動的着席へ縮退**し、閉じた語彙で明示。roster社員を推測で生成しない。1件でも不正なら部分適用せずroster全体を不採用にする（部分rosterは「誰がいないのか」を誤って伝えるため）。**この明示が実装される前にroster-backed UIを有効化しない**（§2.4の順序制約・§5） |
| 未対応actorの扱い | roster外actorは未所属区画へ（§2.3）。**捨てない**。捨てるとstreamの事実と表示が食い違う |
| 対応actor不在のroster社員 | 席は描き、状態は「不在」。`active`・`status`・`last_tool` を捏造しない。playerと同じく「eventが作らない存在」として扱う |
| 決定論的layout | 席座標は `(区画の宣言順, 区画内のroster順)` の2段のみで決まる。actorの有無・到着順・hashを座標に混ぜない。同じroster + 同じviewport → 同じ座標。人物の外見は現行どおり安定key由来（`quest-world.js:204` `appearanceFor`） |
| 上限 | roster人数に明示上限。`max_actors`（4096）とは別の上限で、org側の上限に到達したらorg読み込みを拒否（ingest haltではない） |
| 検証方法 | ① 同一rosterで席座標が bit-for-bit 一致 ② actorが0名でも全roster席が描かれる ③ actorが増減しても既存roster席の座標が動かない ④ roster外actorが未所属区画に出て消えない ⑤ 対応actor不在の社員に状態が捏造されない ⑥ player（`selectPlayer`）が roster席・在席数・選択のいずれにも入らない（既存testの不変を維持） ⑦ roster拒否時に動的着席へ縮退した事実が閉じた語彙で表示される（無言の縮退が無い） |

---

## 4. 未決事項

**推測で埋めてはいけない項目**です。次PRの着手前に、実物を確認して決める必要があります。

### 4.1 ai-company側 `company/org.yaml` の実在と形式 — **未決**

このrepositoryには存在せず、本タスクの範囲で外部repositoryを確認していません。
issue本文に名前が出ているだけです。以下がすべて未確認:

- fileが実在するか、pathとfile名は何か
- 部署が6つ、社員が15名で固定されているか
- 社員に安定した識別子があるか、その値域は何か
- Quest側が読める形（LIVE運用時にどう届くのか、fileを直接読むのか、ai-company側が出力するのか）

**この確認が全ての前提**です。確認できるまで、Quest側にorg schemaを定義してはいけません。

### 4.2 roster社員 ↔ runtime actor の照合key — **未決**

`ActorDirectory` のkey体系は `session_id` を含むscoped keyとbare `agent_id` の2段です
（`src/domain/actor.ts:36-38`）。固定rosterは特定sessionに属さないため、
成立するのはbare `agent_id` 側だけに見えますが、
**ai-company側が社員に安定した `agent_id` を割り当てているかは未確認**（§4.1依存）。

同一社員が複数sessionで同時に動く場合の扱い（席が2つになるのか、1席に集約するのか）も未決です。

### 4.3 「15名」「6部署」を定数として持つか — **未決**

現時点の判断は「持たない」（数はrosterの結果）です。ただしこれは
「条件が満たされたことをどう検証するか」と衝突します。
rosterが14名になったとき、それは正常な変更なのか回帰なのか。
**org定義側で人数が固定されている保証があるかどうか（§4.1）で答えが変わります。**

### 4.4 現行 `seat` field の後方互換 — **未決**

`Desk.seat`（`quest-view.js:643`）は現在「actor index+1」です。
固定着席の席番号を同じfieldに載せると意味が静かに変わり、
`quest-world.js:492` の `normalizeDesk` と `test/ui-world.test.ts` の前提に影響します。
別fieldとして導入する（§3.2）のが安全ですが、両方を並存させる期間の扱いは未決です。

### 4.5 org snapshotの供給経路 — **未決**

環境変数によるpath指定、固定path、ai-company側からの受け渡しのいずれか。
現行の `QUEST_INPUT_PATH` と同じく**設定由来のpathのみ**という境界は動かせません
（`README.md:376`: event内容からpathを組み立てない）が、
新しい環境変数を増やすかどうかは§4.1の結論に依存します。

### 4.6 LIVE/DEMO それぞれのorg snapshot — **未決**

DEMOは「固定13 event・timerも乱数も外部I/Oも無し」（`README.md:80-81`）です。
DEMO用のorg snapshotをfixtureとして持つのか、DEMOではorg機能を無効にするのかは未決。
**DEMO stateがLIVEへ混ざらないという不変条件（`README.md:302-310`）は、どちらを選んでも維持します。**

### 4.7 縮退状態をどの表示面で示すか — **未決**

現行bannerは8 codeの閉じた語彙で、**常にちょうど1 codeだけ**表示されます
（`src/ui/public/quest-view.js:712` `BANNER_CODES`、`README.md:202-211`）。
org縮退を既存bannerで示す場合、stream側の `FAIL_CLOSED` / `DISCONNECTED` を
org側のcodeが押しのけて **stream異常を隠す** 可能性があります。したがって

- 既存bannerの語彙を1 code増やすのか
- bannerとは別の閉じた語彙のstatus表示面を置くのか

は未決です。**どちらを選んでも「閉じた語彙のみ・自由記述なし」「stream状態を隠さない」は満たす**必要があり、
この決定はorg-backed UIを有効化するPR（§5 PR-3）の前提です。
**決定するのは §5 PR-1** です（どちらの表示面を採るかという設計判断までをdocsで確定し、
code名・schema・実装はPR-1では決めません）。

---

## 5. 次PR候補

前後関係のある順に並べています。**PR-1 が完了するまで PR-2 以降は着手できません**（§4.1）。

**順序制約（§2.4）**: org-backed UIを有効化するPRは、縮退を閉じた語彙で示す表示契約を
**同じPRで**必ず含みます。表示契約が入るまでは、org snapshotを読み・検証・保持していても
UIはorg非対応のまま据え置き、無言の縮退状態を作りません。

### PR-1: org定義の事実確認と入力契約の確定（分類A: docs のみ）

- **前提**: なし
- **成果契約**: §4.1〜§4.7 の未決事項に対する**確認結果**をこの文書へ追記する。org定義が実在するなら、そのkeyと値域を「観測した事実」として記録する。§4.1〜§4.6 は外部事実の確認、**§4.7 は事実確認（現行 `BANNER_CODES` が単一codeであること）に基づく設計判断**で、「既存bannerの語彙を1増やす / 別の閉じた語彙のstatus面を置く」のどちらを採るかと、その判断基準（閉じた語彙のみ・自由記述なし・stream状態を隠さない）をこの文書で確定する
- **対象外**: schema定義、code変更、環境変数追加、**新規のfield名・関数名**（PR-2 / PR-3の実装範囲）、**§4.7で採る側の具体的なcode名・文言・DOM構造**（PR-3の実装範囲）
- **完了判定**: §4.1〜§4.7 の未決事項がすべて「確認済み」「設計判断済み」「実在しないため対象外」のいずれかに変わっている

### PR-2: org snapshot読み取りと検証（分類B: code、runtime影響あり）

- **前提**: PR-1
- **成果契約**: org snapshotを読み、`src/domain/validate.ts` と同等の禁止内容checkを通し、検証失敗時はfail closed（org機能のみ無効、ingestはhaltさせない）。`QuestState` へ**独立fieldとして**置く（**field名はこのPRで決める**。この文書では固定しない）。`reduce` は触らない。あわせて **採用 / 不在 / 拒否のいずれであるかを閉じた語彙で読み取れる状態**を同じ独立fieldに保持する（拒否理由は field名 + rule名のみ・§2.4）。表示面の選択は§4.7の結論に従う
- **対象外**: UI（org非対応の現行表示のまま据え置く）、layout、wire schema変更、SSE frame追加
- **完了判定**: 不正なsnapshotが1件でもあればorg全体を不採用にするtestが通る。採用/不在/拒否の状態が閉じた語彙で読めるtestが通る。既存のingest系testが全て不変。**UIの描画結果が現行と一致する**（このPRではorg-backed UIを有効化しない）

### PR-3: roster projection と突き合わせ ＋ 縮退表示（分類B: code、UI影響あり）

**最初のorg-backed UI consumerであるため、縮退表示契約をこのPRに同梱します**（§2.4順序制約・§4.7）。

- **前提**: PR-2（§4.7 の決定はPR-1で確定済み）
- **成果契約**: §2.3 の3規則を純粋関数として実装（**関数名・DOM構造・表示codeはこのPRで決める**。この文書では固定しない）。対応actor不在のroster社員に状態を捏造せず、roster外actorを未所属へ置く。DOM側の社員一覧に区画groupingを反映。**同時に**、PR-2が保持する採用/不在/拒否の状態を閉じた語彙で表示し、org非採用時は現行表示へ縮退したことを利用者へ示す。stream側の状態表示を隠さない
- **対象外**: canvas layout、席座標、自由記述メッセージ
- **完了判定**: §3.2 の検証方法 ④⑤⑥⑦ と §3.1 検証方法 ③ が通る。org拒否時に無言で現行表示へ落ちるcaseがtestで再現できない

### PR-4: 決定論的な区画layoutと固定席座標（分類B: code、描画影響あり）

- **前提**: PR-3
- **成果契約**: `buildWorld` に区画room矩形とroster席座標を追加。actorの有無で座標が動かない。DOM正本 / canvas装飾層の関係は不変
- **対象外**: 操作、選択、pointer hit test（Phase 3の範囲）
- **完了判定**: §3.1 検証方法 ①②、§3.2 検証方法 ①②③ が通る

### PR-5: 縮退経路の最終整合とREADME更新（分類A: docs 中心）

縮退表示そのものはPR-3で入っているため、このPRは**文書と実態の突き合わせ**に縮小します。

- **前提**: PR-4
- **成果契約**: PR-3で入った縮退表示の語彙と挙動をREADMEへ記載し、「既知の制限」（`README.md:437-439`）と本文書を実態に合わせて更新する。canvas layout追加後（PR-4）も縮退経路が変わっていないことを確認する
- **対象外**: 新しい表示状態の追加、新しい自由記述メッセージ（表示は閉じた語彙のまま）
- **完了判定**: READMEに未実装と書かれたままの項目が残らず、本文書の未決事項（§4）に確認済みの項目が残らない

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
