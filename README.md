# AI Company Quest

AI Companyの稼働状況をレトロゲーム風UIで可視化するアプリケーション。

このrepositoryは現在 **Collector / SSE / 共有Reducer のcoreのみ** を実装しています。
**UI（レトロオフィス画面・キャラクター描画）はまだ存在しません。** `npm run live`
はCollectorとSSE endpointだけを起動します。画面が出ないのは仕様です。

---

## 何をするものか

ローカルのClaude Code sessionが書き出す **sanitized JSONL** を安全に読み取り、
1つのpure reducerで状態へ畳み込み、`127.0.0.1` 限定のSSEで再接続可能に配信します。

```
sanitized JSONL file
   └─ tailer (partial line / rotation / truncation)
        └─ strict validation (schema_version=2, fail closed)
             └─ dedupe by event_id  →  collector-assigned ingest_seq
                  └─ shared pure reducer  →  QuestState
                       └─ SSE (127.0.0.1 only, id: = event_id)
```

将来のReact/Canvas UIは、`src/domain/reducer.ts` の **同じreducer** を読み込んで
live streamと録画replayの両方を再生できます。

## 必要環境

- Node.js **22.18以上**（TypeScriptをそのまま実行するtype strippingを使用）
- 依存パッケージ **ゼロ**（`package-lock.json` は意図的に空です）

## ローカル起動

```bash
# 1. 入力となるsanitized JSONLのpathを指定する（絶対pathはcommitしない）
export QUEST_INPUT_PATH="$HOME/path/to/your/sanitized-events.jsonl"

# 2. Collector + SSEを起動
npm run live

# 3. 動作確認
curl -s http://127.0.0.1:4317/health
curl -N  http://127.0.0.1:4317/events/live
```

UIを持たないDEMOデータだけを見たい場合:

```bash
QUEST_INPUT_PATH=/dev/null npm run demo   # DEMO storeにfixtureを投入
curl -N http://127.0.0.1:4317/events/demo
```

`QUEST_INPUT_PATH` が未設定の場合、LIVEは起動せずexit code 1で終了します（fail closed）。

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `QUEST_INPUT_PATH` | なし（必須） | tailするsanitized JSONLのpath |
| `QUEST_PORT` | `4317` | SSE/healthのport |
| `QUEST_START_FROM` | `beginning` | `beginning` / `end`。既存行を読むか末尾から追うか |
| `QUEST_POLL_INTERVAL_MS` | `100` | tail pollingの間隔 |
| `QUEST_MAX_LINE_BYTES` | `65536` | これを超える行は破棄・計数 |
| `QUEST_REPLAY_CAPACITY` | `500` | SSE replay bufferの保持件数 |
| `QUEST_DEDUPE_CAPACITY` | `100000` | `event_id` 重複排除indexの上限 |
| `QUEST_DEMO` | 未設定 | `1` でDEMO storeにfixtureを投入 |
| `QUEST_PLAYER_NAME` | `Player` | human playerの表示名 |

bind hostは **設定できません**。常に `127.0.0.1` です。

## Endpoints

すべて **read-only / GETのみ / loopback限定** です。stateを変更するendpointはありません。

| Endpoint | 内容 |
|----------|------|
| `GET /health` | 稼働状況、LIVE/DEMOそれぞれのingest統計、fail-closed状態、`dropped_slow_subscribers` |
| `GET /events/live` | LIVE namespaceのSSE stream |
| `GET /events/demo` | DEMO namespaceのSSE stream |

SSE frameの構造:

- data frame … `id: <event_id>` / `event: quest_event` / `data: <wire event JSON>`
- control frame … `event: snapshot` / `replay_start` / `replay_end` / `stream_gap`
  （control frameは **`id:` を持ちません**。clientの `Last-Event-ID` を壊さないためです）

### 再接続とreplay

clientが `Last-Event-ID` を送ると:

| 状況 | 応答 |
|------|------|
| そのidがbuffer内にある | `replay_start` → 後続event群 → `replay_end` |
| ingest済みだがbufferから溢れた | `stream_gap`（`reason: "evicted"`）→ `snapshot` |
| このnamespaceで未知のid | `stream_gap`（`reason: "unknown_event_id"`）→ `snapshot` |
| UUIDv4として不正 | `stream_gap`（`reason: "invalid_last_event_id"`）→ `snapshot` |

replay bufferは有界です。gapは黙って埋めず、必ず明示してから現在stateのsnapshotを送ります。

## LIVE / DEMO の分離

LIVEとDEMOは **別のstore instance** です。state、`ingest_seq` counter、重複排除index、
replay buffer、subscriber listのいずれも共有しません。

- reducerは自分のnamespace以外のeventを渡されると **throw** します。
- DEMO fixtureをLIVE storeへ投入しようとすると **throw** します。
- Collectorは生成時に1つのnamespaceへ束縛され、後から変更できません。
- 同じ `event_id` が両方に来ても互いに重複排除しません（独立したstreamのため）。

## Fail-closed条件

| 条件 | 挙動 |
|------|------|
| `QUEST_INPUT_PATH` 未設定 | LIVEを起動しない（exit 1） |
| `schema_version` が2以外（LIVE） | ingestを即時halt。以降の行は全て拒否し、`/health` は `fail_closed` |
| malformed JSON / 契約key欠落 / 型不一致 | その行だけ拒否・理由別に計数 |
| 行がoversized | 破棄・計数（次のnewlineまでskip） |
| 絶対path・shell command・credential様の文字列 | その行を拒否（修復や部分redactはしない） |

`sanitizer_version` は **観測情報** です。値が変わっても拒否もhaltもしません。

## 安全境界

- 出力するのは `src/domain/wire.ts` のwhitelistのみ。producerの未知keyは検証前にdropします。
- raw prompt、raw command、絶対path、secret/credential、内部reasoningは保存も配信もしません。
- 拒否理由は field名 + rule名のみで、問題のあった文字列自体は含めません。
- 入力pathは設定由来のみ。event内容からpathを組み立てることも、任意ファイルを読む機能もありません。
- CORS headerを出さないため、任意のweb originからstreamを読むことはできません。
- Host headerは `127.0.0.1` / `localhost` のみ許可します（DNS rebinding対策）。
- `{session_id}:main` はmain orchestratorという構造上の事実のみを意味し、CEO等の役職は推測しません。
  org情報が無ければ role は `null`、`resolved` は `false` のままです。
- actor identityは `(session_id, agent_id)` のtupleです。両IDとも `:` を含み得るため、
  keyは component ごとに `%` → `%25`、`:` → `%3A` をescapeしてから連結します。
  `agent_id` が `null` の場合のみ marker `%00` を使うので、`unknown` という名のagentとも衝突しません。
  通常のIDでは key はそのまま `${session_id}:${agent_id}` です。
- SSE subscriberは有界です。未flushのbyteが上限（既定1MiB）を超えたclientは
  bufferingを続けず切断・購読解除し、`/health` の `dropped_slow_subscribers` に計上します。
  読まないclientがprocess memoryを無制限に増やすことはありません。

## 開発

```bash
npm test        # node:test（依存なし）
npm run typecheck
```

`npm run typecheck` はTypeScript本体を必要とします。依存ゼロを維持するため、
必要なときだけ取得してください:

```bash
npm install --no-save --no-package-lock typescript@^5.6.0 @types/node@^22.7.0
npm run typecheck
```

CIは `ci/quest-core-ci.yml.example` に用意してあります。GitHub Appは
`.github/workflows/` を書けないため、有効化はownerが行ってください:

```bash
cp ci/quest-core-ci.yml.example .github/workflows/ci.yml
```

既存の `.github/workflows/claude.yml` には触れません。

## 既知の制限

- **UI未実装。** レトロオフィス画面、キャラクター描画、Canvas、Reactはまだありません。
- `player` entityは初期stateにのみ存在し、eventからは絶対に変化しません（testで保証）。
- rotation検出はinode変化に加え、offset直前64byteのsignature照合で行います。
  同一inodeのcopy-truncate後にpoll間で旧offset以上へ再成長した場合も検出し、
  新ファイルの先頭から読み直します（record途中からの誤読はしません）。
  新内容のoffset直前64byteが旧内容と完全一致する場合のみ検出できません。
  ただし1 poll区間内にrotateし、旧ファイル末尾が読まれる前に消えた場合、その分は失われます。
  `stat()` と `open()` の間でファイルが消えてもprocessは落ちず、`missing` を通知して
  replacementのpollingを継続します。
- 重複排除indexは有界（既定10万件）です。これを超えて古いeventの重複が来た場合は再受理されます。
- replay bufferはprocess memoryのみです。再起動でreplay履歴は消え、以後の再接続は
  `unknown_event_id` として扱われます。
- tailerはpolling方式です（fs.watchのplatform差を避けるため）。
- Mac hookの登録、cloud/web session、外部deployは対象外です。
