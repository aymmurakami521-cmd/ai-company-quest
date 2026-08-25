# AI Company Quest

AI Companyの稼働状況をレトロゲーム風UIで可視化するアプリケーション。

このrepositoryは **Collector / SSE / 共有Reducer のcore** と、その上に載る
**レトロオフィス画面のMVP** を実装しています。`npm run live` でCollector・SSE・画面が
同時に起動し、`http://127.0.0.1:4317/` をブラウザで開くとAI社員の状態が1画面で見えます。
画面はbrowser-nativeなHTML/CSS/ES moduleだけで書かれており、依存パッケージはゼロのままです。

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

画面はこのstreamの **snapshotを正本** とし、後続のeventを同じ規則で畳み込みます
（`src/ui/public/quest-view.js`）。そのfoldが `src/domain/reducer.ts` と一致することは
testで突き合わせているため、live streamとreplayが食い違うことはありません。

## 必要環境

- Node.js **22.18以上**（TypeScriptをそのまま実行するtype strippingを使用）
- 依存パッケージ **ゼロ**（`package-lock.json` は意図的に空です）

## ローカル起動

```bash
# 1. 入力となるsanitized JSONLのpathを指定する（絶対pathはcommitしない）
export QUEST_INPUT_PATH="$HOME/path/to/your/sanitized-events.jsonl"

# 2. Collector + SSE + 画面を起動
npm run live

# 3. ブラウザで開く
open http://127.0.0.1:4317/            # LIVE
open http://127.0.0.1:4317/#demo       # DEMO

# 4. HTTPで直接確認したい場合
curl -s http://127.0.0.1:4317/health
curl -N  http://127.0.0.1:4317/events/live
```

LIVE入力を用意せずMVPを確認する場合:

```bash
npm run demo                            # DEMO storeにfixtureを投入して起動
open http://127.0.0.1:4317/#demo
```

`npm run demo` は `QUEST_INPUT_PATH` を指定しなければ `/dev/null` を使うため、
credentialもlocal sessionも不要です（既存の値があればそれを優先します）。
`npm run live` で `QUEST_INPUT_PATH` が未設定の場合、LIVEは起動せず
exit code 1で終了します（fail closed）。

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
| `GET /` | レトロオフィス画面（HTML） |
| `GET /ui/quest.css` | 画面のstyle |
| `GET /ui/quest-app.js` | DOM + SSE glue |
| `GET /ui/quest-view.js` | 純粋なview model（状態mapping・席割り・client fold） |
| `GET /health` | 稼働状況、LIVE/DEMOそれぞれのingest統計、fail-closed状態、`dropped_slow_subscribers`、`state_limits` |
| `GET /events/live` | LIVE namespaceのSSE stream |
| `GET /events/demo` | DEMO namespaceのSSE stream |

静的assetは **固定tableのexact match** でのみ解決します。request pathからファイルpathを
組み立てることはなく、ファイルはprocess起動時に一度だけ読み込まれるため、path traversalの
余地も request毎のdisk accessもありません。assetには
`default-src 'none'; script-src 'self'; connect-src 'self'; …` のCSPを付与しています。

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

## レトロオフィス画面

1画面に次を表示します。

- pixel風のオフィス空間（壁・窓・床・机）と、actorごとの席＋キャラクター
- actorの表示名（`agent_id`。producerが特定できない場合は `unattributed`）、
  role（**`resolved` のときだけ**。推測はしません）、現在状態、last tool、session、最終event時刻
- 接続モード **LIVE / DEMO**、接続状態、最終更新、最新 `ingest_seq`、在席数
- 状態の凡例と、上限付きのアクティビティログ

### 画面に出る状態

状態の判定は `src/ui/public/quest-view.js` の **純粋関数** に閉じています。
色・animationだけに依存せず、記号とlabelを必ず併記します。

| 状態 | 記号 | 判定 |
|------|------|------|
| 待機中 `IDLE` | `⋯` | `idle` / `waiting` / `queued` など、または未起動 |
| 作業中 `WORKING` | `▶` | `active` / `running` / `thinking` など、または status不明で `active` |
| 承認待ち `APPROVAL` | `‼` | `approval` / `permission` / `confirm` などを含む status |
| 完了・終了 `ENDED` | `■` | `completed` / `stopped` / `ended`、`session_end` 後 |
| エラー・停止 `ERROR` | `✖` | `error` / `failed` / `timeout` / `denied` など |

status labelはsanitized eventの自由記述なので、小文字化・token分割してから
上表の優先順（error → 承認待ち → 作業中 → 終了 → 待機）で判定します。
未知のlabelは推測せず、reducerが持つ `active` にfallbackします。

接続側は `未接続` / `接続中` / `接続済み` / `再接続中` / `切断・エラー` と、
ingestがhaltしている場合の `取り込み停止 (fail-closed)` を表示します。
`stream_gap` は黙って埋めず、明示bannerを出してから後続の `snapshot` で復旧します。

### 画面側の分離と境界

- 接続は**常に1本**です。LIVE/DEMOを切り替えると接続を閉じ、client stateを
  namespaceごとに作り直します。他namespaceのeventやsnapshotは適用せず計数だけします。
- 画面が出すrequestは、documentされた2本のSSE GETだけです。state変更・任意path読み込み・
  command実行・外部送信は追加していません（CSPでも封じています）。
- stream由来の文字列は `textContent` でのみDOMへ入ります。console出力もしません。
- 表示するのは `src/domain/wire.ts` のwhitelist fieldだけです。

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
| state保持上限に到達（LIVE / DEMO両方） | ingestを即時halt。上限超過のeventは適用せず、既存stateは削除も置換もしない |
| malformed JSON / 契約key欠落 / 型不一致 | その行だけ拒否・理由別に計数 |
| 行がoversized | 破棄・計数（次のnewlineまでskip） |
| 絶対path・shell command・credential様の文字列 | その行を拒否（修復や部分redactはしない） |

`sanitizer_version` は **観測情報** です。値が変わっても拒否もhaltもしません。

## State保持上限（bounded memory）

reducerが保持する構造は、event内容で増えるものすべてに明示的な上限があります。
上限は `src/domain/reducer.ts` の `DEFAULT_STATE_LIMITS` に定義され、`/health` の
`namespaces.<ns>.state_limits` で確認できます。

| 上限 | 既定値 | 対象 |
|------|--------|------|
| `max_sessions` | `512` | 保持する `session_id` の種類数 |
| `max_actors` | `4096` | 全sessionを通じたactorの総数 |
| `max_actors_per_session` | `256` | 1 sessionの `actor_keys` 配列長 |
| `max_event_types` | `64` | `counters.by_type` のbucket数 |

挙動:

- **上限までは通常どおり受理**します。既知のactor・session・event_typeへのeventは
  保持量を増やさないため、上限に達した後も **受理され続けます**（duplicateもduplicateのまま）。
- **新しいkeyが上限を超える場合**、そのeventは適用せずingestを **halt** します（fail closed）。
  LIVE・DEMOとも同じ挙動です。silent evictionは行いません。既存のactor/sessionを捨てると
  配信中のstateが「streamにあった事実」と食い違うためです。
- halt後は `/health` が `fail_closed` になり、`halt_reason` は `state_limit:<上限名>:<値>` です。
  `session_id` や `agent_id` などのstream内容は含みません。以降の行はすべて拒否されます。
- halt後の **再開手段はprocess再起動のみ** です。state・`ingest_seq`・replay bufferは
  process memoryのみに存在するため、再起動で初期化されます。
- 上限に環境変数はありません（設定面を増やさないため）。変更する場合は
  `NamespaceStore` の `stateLimits` option を使います。

これにより、`event_id` 重複排除index・replay buffer・SSE client bufferに加えて
**reduced stateも有界**となり、常時稼働のcollectorがheapを使い切ることはありません。
`/health` と SSE snapshotのサイズも同じ上限で頭打ちになります。

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
- reduced stateも有界です。session・actor・`actor_keys`・`by_type` bucketには明示的な上限があり、
  超過時はsilent evictionではなくsanitized reasonでhaltします（「State保持上限」参照）。

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

- **UIはMVPです。** voice input、character editor、pathfinding・自由移動、Skills/MCP、
  cloud/web session、auth、analyticsはいずれも対象外です。
- 画面は現在の状態を表示するだけで、履歴の巻き戻しや録画replayのUIはありません。
- fail-closedの表示は接続時の `snapshot` に含まれる `halted` から判定します。接続したまま
  ingestがhaltした場合、そのbannerは次の再接続まで出ません（`/health` には即時反映されます）。
- 画面はDEMO fixtureで全状態を再現できますが、`state_limit` によるhaltはDEMOでは起こしません
  （DEMOを止めないため）。fail-closed表示自体はtestで検証しています。
- 画面のレンダリングを検証する自動testはDOM contract（要素・selector・状態style・
  reduced-motion）と純粋関数までで、実ブラウザでのpixel比較は行っていません。
- `player` entityは初期stateにのみ存在し、eventからは絶対に変化しません（testで保証）。
- rotation検出はinode変化に加え、offset直前64byteのsignature照合で行います。
  同一inodeのcopy-truncate後にpoll間で旧offsetと同一sizeまで再成長した場合も、
  旧offset超へ再成長した場合も検出し、新ファイルの先頭から読み直します
  （record途中からの誤読はしません）。sizeが変わらないpollでもsignatureは毎回照合するため、
  検出のために追記を待つことはありません。
  新内容のoffset直前64byteが旧内容と完全一致する場合のみ検出できません。
  `QUEST_START_FROM=end` で途中から追い始めた場合も、初回pollでEOF直前のbyteを
  signatureとしてseedするため、その直後のcopy-truncateを検出できます。
  ただし1 poll区間内にrotateし、旧ファイル末尾が読まれる前に消えた場合、その分は失われます。
  `stat()` と `open()` の間でファイルが消えてもprocessは落ちず、`missing` を通知して
  replacementのpollingを継続します。
- path経由の `stat()` はpolling用のprobeにすぎません。inode比較、`QUEST_START_FROM=end`
  で採用するEOF、signatureのseed／照合、読み出す長さは、すべて実際に読むhandleの
  `fstat` から決めます。probeとopenの間にrotationやcopy-truncateが入っても、
  別ファイルのoffsetを引き継いだり、record途中で切った断片を次pollのbyteと連結したり
  しません。なお `end` modeでその競合が起きた場合、開いたfileの既存内容は
  「追い始めた時点の履歴」として設計どおりskipされます。
- state内でstream内容をkeyにするmap（`sessions` / `actors` / `by_type` など）はすべて
  prototypeを持たず、参照もown property照合で行います。`__proto__` や `constructor` と
  いった `session_id` / `agent_id` / `event_type` も通常の識別子として扱われ、
  継承memberの誤認やそれに伴うrecord欠落は発生しません。
- 重複排除indexは有界（既定10万件）です。これを超えて古いeventの重複が来た場合は再受理されます。
- state保持上限に到達するとingestがhaltします。長時間稼働でsession/actorが増え続ける運用では、
  上限に達した時点で以降のeventが失われるため、定期的な再起動かfileのrotationが前提です。
- replay bufferはprocess memoryのみです。再起動でreplay履歴は消え、以後の再接続は
  `unknown_event_id` として扱われます。
- tailerはpolling方式です（fs.watchのplatform差を避けるため）。
- Mac hookの登録、cloud/web session、外部deployは対象外です。
