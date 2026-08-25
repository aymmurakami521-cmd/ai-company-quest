# Sanitized event contract (schema_version = 2)

Collectorが受理する唯一の入力形式です。1行1 JSON objectのJSONLで、
producerは **sanitize済みの値だけ** を書き出します。

正本は `src/domain/event.ts` と `src/domain/validate.ts` です。この文書と実装が
食い違った場合は実装が正です。

## 互換性ルール

- `schema_version` **のみ** が互換judgementのgateです。`2` 以外はLIVEでfail closed。
- `sanitizer_version` は観測情報です。値が変わっても受理判定には使いません。
- 契約keyは **常に全て存在** します。値が無い場合は明示的な `null` で、key欠落は拒否です。
- 未知のkeyは検証時にdropされ、wireへは出ません（sanitizer側の前方互換のため）。

## Keys

| key | 型 | 制約 |
|-----|----|------|
| `schema_version` | number | `2` 固定 |
| `sanitizer_version` | number | 0以上の整数。観測用 |
| `event_id` | string | 小文字canonical UUIDv4。重複排除とSSE `id:` に使用 |
| `session_id` | string | `[A-Za-z0-9._:-]{1,128}` |
| `ts` | string | ISO-8601（`2026-01-01T00:00:00.000Z` 等） |
| `event_type` | string | `[a-z][a-z0-9_]{0,63}` |
| `agent_id` | string \| null | `[A-Za-z0-9._:-]{1,128}` |
| `agent_role` | string \| null | 短いlabel。無ければ `null`（推測しない） |
| `producer_seq` | number \| null | 診断用。順序判定には **使わない** |
| `status` | string \| null | 短いlabel |
| `tool_name` | string \| null | tool label（command lineではない） |
| `duration_ms` | number \| null | 0以上の整数 |
| `token_count` | number \| null | 0以上の整数 |
| `summary` | string \| null | 256文字以内のsanitized表示用label |

## 既知の `event_type`

`session_start` / `session_end` / `agent_start` / `agent_stop` / `agent_status` /
`tool_use` / `handoff` / `heartbeat`

上記以外でも形式が正しければ受理し、reducerは解釈せず `counters.ignored` に計上します。

## 禁止内容

以下に該当する文字列を含む行は、その行ごと拒否されます（部分redactはしません）。

- 絶対path（`/Users/…`、`/home/…`、`~/…`、`C:\Users\…`、UNC path、`file://`）
- shell command片（`sudo `、`rm -rf`、`curl -`、`wget http`、`ssh user@`）
- credential様の文字列（`sk-ant-…`、`sk-…`、`ghp_…`、`github_pat_…`、`AKIA…`、
  `xox…`、JWT、`Bearer …`、PEM private key block、`password: …` 形式の代入）
- `summary` については上記に加え、48文字以上の連続opaque blob

## 例

```json
{"schema_version":2,"sanitizer_version":3,"event_id":"11111111-1111-4111-8111-111111111111","session_id":"sess-1","ts":"2026-01-01T00:00:00.000Z","event_type":"agent_start","agent_id":"main","agent_role":null,"producer_seq":null,"status":"active","tool_name":null,"duration_ms":null,"token_count":null,"summary":"main orchestrator online"}
```

## ingest semantics

1. 行を読む（partial lineはnewlineが来るまでbuffer）
2. 厳格検証（失敗した行は理由別に計数して破棄）
3. `event_id` で重複排除
4. **受理かつuniqueな行にだけ** Collectorが `ingest_seq` を 1 から単調増加で付与
5. 共有reducerで畳み込み、replay bufferへ積み、subscriberへ配信

`producer_seq` は記録するだけで、順序にも採番にも使いません。
