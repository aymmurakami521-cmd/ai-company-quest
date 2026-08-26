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
| `activity` | object | `{kind, facility, label}`（全て非null） |
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
| `agent_id` | `agent.id` | `null` のときのみ `"main"`（正本の同定規則 `{session_id}:main`） |
| `agent_role` | — | 常に `null`。roleはActorDirectoryだけが与える |
| `runtime_agent_type` | `agent.type` | そのまま保持。**roleではない**ため `agent_role` へ入れない |
| `producer_seq` | — | 常に `null`（producerはsequenceを出さない） |
| `status` | `hook_event` | 下のlifecycle table。`outcome.status` のcopyではない |
| `tool_name` | `tool.name` | そのまま |
| `duration_ms` | `outcome.duration_ms` | そのまま（0..86400000の整数） |
| `token_count` | — | 常に `null`（producerはtoken情報を出さない） |
| `summary` | `activity.label` | producerの固定文言表の値。内部validatorのunsafe scanを通す |

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

`hook_event: null` かつ `activity.kind: "capacity"` かつ `outcome.status: "limit_reached"`
の3点が揃った行は、正本が定義する **容量上限marker** です。

これは業務eventではありません。「ここから履歴が欠落する」という事実なので、
**fail-closed control** として扱います。

- reducerへは畳み込まれません（デスクは動きません）
- storeは `halt_reason: "producer_capacity:producer:limit_reached"` でingestを停止します
- SSEは `fail_closed` frameを送り、`/health` は `fail_closed` になります
- 画面は閉じた語彙の **固定文言** だけを表示します（marker本文は表示しません）

`hook_event: null` でこの3点が揃わない行、既知の `hook_event` にcapacity signalが
混ざった行は、定義の無い形なので **reject** します。

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
| `session_id: null` | その行をreject（sentinelを作らない） | `unattributable` |
| known table外・`null`（非marker）の `hook_event` | その行をreject | `unsupported_hook_event` |

reject detailは **field名とrule名だけ** です。失敗した値は含めません
（例 `activity.label:posix_path`、`hook_event:not_in_known_table`）。

## 保存・表示・logしないもの

producerが出さないもの（完全prompt、Bash command、tool input/output、file path、
environment値、credential、内部推論、transcript path、assistant message、
task subject/description、error detail原文、permission reason原文、notification message、
custom instructions）は、このrepositoryでも **追加取得しません**。
`hookWire.ts` はmodelしたkeyだけを組み立て、`hookAdapter.ts` は上のmapping表の行だけを使います。
