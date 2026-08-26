# 外部LIVE wire contract（Claude Code Hook, schema_version = 2）

LIVE ingestが受理する **唯一の外部入力形式** です。1行1 JSON objectのJSONLで、
producerは **sanitize済みの値だけ** を書き出します。

- producer正本: `aymmurakami521-cmd/ai-company`
  `scripts/quest-hook-emit.py` / `docs/ai-company-quest/01-event-schema.md`
  （固定SHA `3306b2b3c07a17a7d1de2c66e6669f0e6bb02a2f`）
- consumer正本: `src/domain/hookWire.ts`（形式検証）と `src/domain/hookAdapter.ts`（意味mapping）

この文書と実装が食い違った場合は実装が正です。

## 2つの `schema_version: 2` を混同しない

同じversion番号で **形が違う契約が2つ** あります。

| | 形 | 正本 | 使う場所 |
|---|---|---|---|
| **外部LIVE wire** | rich / nested | `src/domain/hookWire.ts` | Claude Code Hookからの入力のみ |
| **内部normalized model** | flat | `src/domain/event.ts`（[event-contract.md](event-contract.md)） | reducer / SSE / 画面 / DEMO fixture |

**どちらの契約を使うかはpayloadから推測しません。** `NamespaceStore` の
`inputContract`（`'claude_hook_v2'` / `'internal_normalized'`）が生成時に決め、
以後変わりません。`src/live.ts` はLIVE storeを `claude_hook_v2`、DEMO storeを
`internal_normalized` で生成します。したがって、

- flat eventをLIVE storeへ入れても **受理されません**（`missing_key: producer:absent`）
- rich wire eventをDEMO storeへ入れても **受理されません**（`missing_key: event_type:absent`）

## 経路

```
sanitized JSONL (rich/nested v2)
  └─ tailer
       └─ 外部wire検証        src/domain/hookWire.ts   ← 形式・値域・producer identity
            └─ allowlist adapter  src/domain/hookAdapter.ts ← 意味mapping / drop / reject
                 └─ 内部validator  src/domain/validate.ts   ← 内容規則の再検証（2枚目のgate）
                      └─ dedupe → ingest_seq → shared reducer → SSE → 画面
```

adapterの出力を内部validatorへ **もう一度通します**。mappingが将来変わっても、
絶対path・credential・control文字・長さの規則がwireと画面に効き続けるためです。

## 外部wireのkeys

top-level keyは **常に全て存在** します。値が無い場合は明示的な `null` です。

| key | 型 | 制約 |
|-----|----|------|
| `schema_version` | number | `2` 固定。**唯一の互換gate** |
| `sanitizer_version` | number | 0以上の整数。観測用。受理判定に使わない |
| `event_id` | string | 小文字canonical UUIDv4 |
| `ts` | string | UTC・ミリ秒3桁固定・末尾 `Z` |
| `producer` | object | `{kind:"claude-code-hook", host_id:[0-9a-f]{12}, env:"local"}` |
| `session_id` | string \| null | `[A-Za-z0-9_-]{1,128}` |
| `prompt_id` | string \| null | 同上 |
| `agent` | object | `{id, type, parent_session_id:null}` |
| `hook_event` | string \| null | `[A-Za-z][A-Za-z0-9]{0,63}`。`null` はcapacity marker専用 |
| `session` | object | `{source, end_reason}`（各々閉じた語彙 \| null） |
| `tool` | object | `{name, category, mcp_server, tool_use_id}` |
| `skill` | object \| null | `{name:string, source:null}` |
| `task` | object \| null | `{id:string\|null}` |
| `activity` | object | `{kind, facility, label}`（全て非null）。**下の固定tupleと完全一致のみ受理** |
| `outcome` | object | `{status, duration_ms, is_interrupt, error_kind, denial_kind}` |
| `workspace` | object | `{repo_id, bucket}` |
| `truncated` | boolean | `false` 固定（`true` はfail-closed） |

`producer.kind` / `producer.env` は明示的に検証します。`schema_version: 2` を
名乗るだけの別payloadは、ここで止まります。

## 完全なfield mapping（外部wire → 内部normalized）

| 内部normalized field | 由来 | 規則 |
|---|---|---|
| `schema_version` | 定数 `2` | 内部modelのversion |
| `sanitizer_version` | `sanitizer_version` | そのまま。受理判定に使わない |
| `event_id` | `event_id` | そのまま。dedupeとSSE `id:` に使用 |
| `session_id` | `session_id` | **非nullのみ**。`null` は行ごとreject |
| `ts` | `ts` | そのまま |
| `event_type` | `hook_event` | 下のlifecycle table |
| `agent_id` | `agent.id` | `null` のときのみ `"main"`（正本の同定規則 `{session_id}:main`）。**identity不整合の行には適用しない**（下表） |
| `agent_role` | — | 常に `null`。roleはActorDirectoryだけが与える |
| `runtime_agent_type` | `agent.type` | そのまま保持。**roleではない**ため `agent_role` へ入れない |
| `producer_seq` | — | 常に `null`（producerはsequenceを出さない） |
| `status` | `hook_event` | 下のlifecycle table。`outcome.status` のcopyではない |
| `tool_name` | `tool.name` | そのまま |
| `duration_ms` | `outcome.duration_ms` | そのまま（0..86400000の整数） |
| `token_count` | — | 常に `null`（producerはtoken情報を出さない） |
| `summary` | `activity.label` | producerの固定文言表と **完全一致した値のみ**（下表）。内部validatorのunsafe scanも通す |

### lifecycle table（`hook_event` → `event_type` / `status`）

`status` は正本のmapping判断に従い **tableから決めます**。producerの `outcome.status` は
hookの結果を表す語彙で、内部の `status` はデスクの状態を表す語彙です。一致する行と
一致しない行（`SubagentStart` は上流 `started` / 内部 `active`）があるため、copyは誤りになります。

| `hook_event` | `event_type` | `status` |
|---|---|---|
| `SessionStart` | `session_start` | `started` |
| `SessionEnd` | `session_end` | `ok` |
| `SubagentStart` | `agent_start` | `active` |
| `SubagentStop` | `agent_stop` | `stopped` |
| `UserPromptSubmit` | `agent_start` | `active` |
| `Stop` | `agent_stop` | `stopped` |
| `StopFailure` | `agent_stop` | `error` |
| `PreToolUse` | `tool_use` | `started` |
| `PostToolUse` | `tool_use` | `ok` |
| `PostToolUseFailure` | `tool_use` | `error` |
| `PermissionRequest` | `agent_status` | `permission` |
| `PermissionDenied` | `agent_status` | `denied` |
| `Notification` | `agent_status` | `waiting` |
| `PreCompact` | `agent_status` | `started` |
| `TaskCreated` | `internal_task` | `started` |
| `TaskCompleted` | `internal_task` | `ok` |

`internal_task` は `KNOWN_EVENT_TYPES` の **外** です。`TaskCreated` / `TaskCompleted` は
Claude内部のbookkeepingであり業務taskではないため、reducerは解釈せず
`counters.ignored` に計上します。

### 固定activity tuple（`activity.label` はsanitized free textではない）

`activity.label` は外部からの文字列で **唯一画面に出るもの**（内部 `summary`）です。
長さ・control文字・unsafe patternのcheckだけでは「無害に見える任意の文」（生promptや
command片）が通ってしまうため、正本の **固定文言表と完全一致** することを要求します。
labelは単独では判定せず、`activity.kind` / `activity.facility` / `outcome.status` と
**組で** 一致する必要があります（別eventや別categoryの正しいlabelも拒否されます）。

| `hook_event` | `activity.kind` | `activity.facility` | `activity.label` | `outcome.status` |
|---|---|---|---|---|
| `SessionStart` | `session` | `desk` | セッションが開始されました | `started` |
| `SessionEnd` | `session` | `desk` | セッションが終了しました | `ok` |
| `SubagentStart` | `delegate` | `meeting` | 専門Agentが起動しました | `started` |
| `SubagentStop` | `delegate` | `meeting` | 専門Agentの処理が終了しました | `ok` |
| `UserPromptSubmit` | `idle` | `desk` | イベントを記録しました | `started` |
| `Stop` | `session` | `desk` | 応答処理が終了しました | `ok` |
| `StopFailure` | `session` | `desk` | APIエラーで応答が終了しました | `error` |
| `PermissionRequest` | `permission` | `desk` | 権限確認が発生しました | `waiting` |
| `PermissionDenied` | `permission` | `desk` | 自動モードで実行が許可されませんでした | `auto_denied` |
| `Notification` | `session` | `desk` | 通知が発生しました | `waiting` |
| `PreCompact` | `session` | `desk` | コンテキスト整理が開始されました | `started` |
| `TaskCreated` | `task` | `desk` | 内部タスクが作成されました | `started` |
| `TaskCompleted` | `task` | `desk` | 内部タスクが完了しました | `ok` |

tool eventのtupleは **検証済みの `tool.name`** とphaseから一意に決まります。
`facility` は category の関数では **ありません**。正本 `scripts/quest-hook-emit.py` は
`kind, facility = _category(tool_name, mcp_server)` として **名前から両方を同時に** 決めるため、
同じ `search` でも `Grep` は `search-terminal`、`WebSearch` / `WebFetch` は `antenna` です。
consumer側の表も **tool名をkey** にしています（`HOOK_TOOL_CLASS`）。

| `tool.name` | `tool.category` | `facility` |
|---|---|---|
| `Read` / `Glob` | `read` | `shelf` |
| `Write` / `Edit` / `NotebookEdit` | `write` | `desk` |
| `Bash` / `PowerShell` | `exec` | `terminal` |
| `Grep` | `search` | `search-terminal` |
| `WebSearch` / `WebFetch` | `search` | `antenna` |
| `Agent` | `delegate` | `meeting` |
| `Skill` | `skill` | `desk` |
| `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskStop` / `TaskOutput` | `idle` | `desk` |
| `^mcp__([A-Za-z0-9_-]{1,64}?)__` に **完全一致** する名前 | `mcp` | `portal` |
| 上記以外・`tool.name` が `null` | `idle` | `desk` |

`Skill` は正本の表では `skill / workshop` ですが、`workshop` は出力facility語彙外で、
producer自身の `_safe_facility` が **出力前に** `desk` へ落とすため、wire上は `skill / desk` です。

`tool.category` は非nullが必須で、名前から導いた category と **一致** しなければなりません
（不一致は `tool.category:not_fixed_for_tool`）。`tool.name` は非null必須では **ありません**:
未知名・名前なしは正本と同じく `idle / desk` fallbackになります（labelもfallbackのものだけ）。

#### `tool.mcp_server` は `tool.name` の関数

正本は server を **名前だけ** から導きます。供給された `tool.mcp_server` は分類に使いません。

```python
RE_MCP_SERVER = re.compile(r"^mcp__([A-Za-z0-9_-]{1,64}?)__")
mcp_match = RE_MCP_SERVER.match(tool_name) if tool_name else None
mcp_server = mcp_match.group(1) if mcp_match else None
kind, facility = _category(tool_name, mcp_server)
```

したがって `tool.mcp_server` は **正規表現の捕獲結果と完全一致**（非一致の名前・`null` 名なら `null`）
でなければならず、それ以外はproducerが出力し得ない組み合わせとして
`tool.mcp_server:not_derived_from_name` で拒否します（tool event以外の行も同じ規則: tool無し ⇒ server無し）。

| 例 | 期待 `tool.mcp_server` | 判定 |
|---|---|---|
| `mcp__github__get_issue` | `github` | `mcp / portal` |
| `mcp__a__b__tool`（lazy量指定子） | `a` | `mcp / portal` |
| server部64文字 | その64文字 | `mcp / portal` |
| server部65文字・`mcp__github`・`mcp__`・`mcp____x` | `null` | 未知名fallback `idle / desk` |
| `Bash` など通常名 | `null` | 名前表どおり |

`Bash` + 任意server、MCP名 + `null`/別/詐称server、不完全prefixのMCP主張は、
すべてadapter / SSE / UIより **手前** で拒否されます。拒否detailはfield名とruleのみで、
tool名やserver値を含みません。

labelは category とphaseで決まります。

| `tool.category` | `PreToolUse`（`started`） | `PostToolUse`（`ok`） |
|---|---|---|
| `read` | 資料を確認中 | 資料の参照を確認しました |
| `write` | 作業内容を編集中 | 変更処理を確認しました |
| `exec` | コマンドを実行中 | ターミナル処理を確認しました |
| `search` | 情報を検索中 | 検索処理を確認しました |
| `mcp` | 外部サービスと通信中 | 外部サービスとの通信を確認しました |
| `delegate` | 担当者に作業を依頼中 | 委任処理を確認しました |
| `skill` | 手順書を実行中 | 手順書の実行を確認しました |
| `idle` | 作業中 | ツール処理を確認しました |

`tool.name` が `WebSearch` / `WebFetch` の場合のみ、labelは category ではなく名前で決まります
（`外部資料を調査中` / `外部調査の完了を確認しました`）。`PostToolUseFailure` は category に依らず
`ツール処理が失敗しました`（`error`）です。

known table外の `hook_event` には固定tupleがありません。これは意図的で、
そのeventは `hookAdapter.ts` が `unsupported_hook_event` として **mapping前にreject** するため、
labelがstate / SSE / 画面へ届く経路は存在しません。

### `hook_event` と agent identityの整合（adapter, mapping前）

`agent.id` が `null` のときの `"main"` は正本の同定規則ですが、**適用できる行は決まっています**。

| `hook_event` | 許される identity |
|---|---|
| `SubagentStart` / `SubagentStop` | `agent.id` **非null必須**（subagent自身のlifecycle） |
| `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `Stop` / `StopFailure` | `agent.id` **null必須**（sessionとmainの行） |
| tool / permission / notification / precompact / task | どちらでも可（`null` は `"main"`） |

違反した行は `identity_conflict` でrejectします。`agent.id: null` の `SubagentStart` を
`"main"` として畳み込むと、orchestratorのデスクが動いた上に本来のsubagentが消えるためです。
`agent.type` からroleを推定しないことは従来どおりです（`agent_role` は常に `null`）。

## dropするfield（受け皿が無いもの）

意味を保てる受け皿が内部modelに無いため、**近似せずdrop** します。raw objectのspreadは
どこでも行いません。

`prompt_id` / `producer.host_id` / `session.source` / `session.end_reason` /
`tool.category` / `tool.mcp_server` / `tool.tool_use_id` / `skill` / `task` /
`agent.parent_session_id` / `outcome.is_interrupt` / `outcome.error_kind` /
`outcome.denial_kind` / `workspace.repo_id` / `workspace.bucket` /
`activity.kind` / `activity.facility` / `truncated`

`workspace.*` は絶対path混入の余地があるため特にdrop対象です。modelしていないkeyも
検証時にdropされ、`/health` の `dropped_producer_keys` に **件数だけ** 計上されます。

## capacity marker

正本の `limit_marker_event` は定数だけから組み立てられます。したがって
**容量上限marker** は、次の形を **すべて** 満たす行 **だけ** です。

| 位置 | 固定値 |
|---|---|
| activity tuple | `capacity` / `desk` / `本日の記録上限に達しました` / `limit_reached` |
| identity | `session_id: null` / `prompt_id: null` / `agent.id: null` / `agent.type: null` |
| `hook_event` | `null` |
| session | `session.source: null` / `session.end_reason: null` |
| tool | `tool.name` / `category` / `mcp_server` / `tool_use_id` すべて `null` |
| skill / task | `skill: null` / `task: null` |
| outcome残り | `duration_ms` / `is_interrupt` / `error_kind` / `denial_kind` すべて `null` |
| workspace | `workspace.repo_id: null` / `workspace.bucket: null` |
| 全行共通 | `agent.parent_session_id: null` / `truncated: false` |
| 未modelled key | top-level / nestedを問わず **1つも無い**（dropが1件でもあればmarkerではない） |

`schema_version` / `sanitizer_version` / `event_id` / `ts` / `producer` は業務行と同じく
通常検証します（markerも実値を持ちます）。`sanitizer_version` はここでも
**observational** で、受理を左右しません。

これは業務eventではありません。「ここから履歴が欠落する」という事実なので、
**fail-closed control** として扱います。

- reducerへは畳み込まれません（デスクは動きません）
- storeは `halt_reason: "producer_capacity:producer:limit_reached"` でingestを停止します
- SSEは `fail_closed` frameを送り、`/health` は `fail_closed` になります
- 画面は閉じた語彙の **固定文言** だけを表示します（marker本文は表示しません）

`hook_event: null` でこの形に **1フィールドでも** 一致しない行、
既知の `hook_event` にcapacity signalが混ざった行は、定義の無い形なので
**その行だけをreject** します。marker近似行がhaltを起こすと、1行のmalformedが
**そのsession以降の履歴全体の喪失** になるため、近似はrejectの側に倒します。
rejectしても後続の正当な業務行はそのままingestされます。
haltするのは正本と完全一致したmarkerだけです。

未modelled keyだけは、この行と業務行で扱いが逆になります。業務行では
将来のproducerと前方互換であるためにdropしてingestを続けますが、marker候補では
**dropした時点でmarkerではない** と判定します。dropは記録を残さず行を作り直すため、
そのまま許すと「不可能な行が、不可能にしている当のkeyを外されてmarkerになる」
経路ができ、1行でsession以降が失われます。厳格化はこのcontrol境界だけに閉じます。
rejectのdetailは `dropped_keys:unknown_key_for_capacity` で、
**dropされたkey名も値も含みません**（key名自体がproducer由来のcontentのため）。

判定は `isHookCapacityRow(wire, droppedKeys)`（`src/domain/hookWire.ts`）が唯一の定義で、
wire検証もadapterのhalt判定も同じ関数を参照します。`droppedKeys` は省略可能ではなく
**必須引数** です。modelled recordだけでは「producerが他に何を送ったか」を示せないため、
渡し忘れられる形にしておくと、wireが見ていない証拠でadapterがhaltできてしまいます。
検証の最後には `hook_event: null` の行がこの述語を満たすことを再確認し、
満たさなければ `contract_mismatch:hook_event:incomplete_capacity_row` でrejectします。

## reject / halt の一覧

| 条件 | 挙動 | reason |
|---|---|---|
| `schema_version` が2以外 | LIVE ingestを **halt** | `unsupported_schema` |
| capacity marker | LIVE ingestを **halt** | `producer_capacity` |
| `producer.kind` / `producer.env` 不一致 | その行をreject | `unsupported_producer` |
| top-level / nested keyの欠落 | その行をreject | `missing_key` |
| 型不一致 | その行をreject | `type_error` |
| 値域外・pattern不一致・`truncated:true` | その行をreject | `invalid_format` |
| 長さ超過 | その行をreject | `field_too_long` |
| 絶対path・shell command・credential様の文字列 | その行をreject | `unsafe_content` |
| 固定activity tuple不一致・capacity marker不一致 | その行をreject | `contract_mismatch` |
| `session_id: null` | その行をreject（sentinelを作らない） | `unattributable` |
| known table外・`null`（非marker）の `hook_event` | その行をreject | `unsupported_hook_event` |
| `hook_event` と agent identityの矛盾 | その行をreject | `identity_conflict` |

reject detailは **field名とrule名だけ** です。失敗した値は含めません
（例 `activity.label:posix_path`、`activity.label:not_fixed_for_event`、
`agent.id:required_for_subagent_event`、`hook_event:not_in_known_table`）。

## 保存・表示・logしないもの

producerが出さないもの（完全prompt、Bash command、tool input/output、file path、
environment値、credential、内部推論、transcript path、assistant message、
task subject/description、error detail原文、permission reason原文、notification message、
custom instructions）は、このrepositoryでも **追加取得しません**。
`hookWire.ts` はmodelしたkeyだけを組み立て、`hookAdapter.ts` は上のmapping表の行だけを使います。
