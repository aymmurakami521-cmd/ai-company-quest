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
sanitized JSONL file (Claude Code Hook, rich/nested schema_version=2)
   └─ tailer (partial line / rotation / truncation)
        └─ external wire validation (src/domain/hookWire.ts, fail closed)
             └─ allowlist adapter    (src/domain/hookAdapter.ts)
                  └─ internal normalized model + content re-check (src/domain/validate.ts)
                       └─ dedupe by event_id  →  collector-assigned ingest_seq
                            └─ shared pure reducer  →  QuestState
                                 └─ SSE (127.0.0.1 only, id: = event_id)
```

外部wireと内部modelは **どちらも `schema_version: 2` ですが別の契約** です。
どちらで読むかは `NamespaceStore` の `inputContract` が生成時に決め、payloadの形からは
推測しません（LIVEは `claude_hook_v2`、DEMOは `internal_normalized`）。
契約と完全なfield mappingは [`docs/live-wire-contract.md`](docs/live-wire-contract.md) と
[`docs/event-contract.md`](docs/event-contract.md) にあります。

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

`npm run live` で `QUEST_INPUT_PATH` が未設定の場合、LIVEは起動せず
exit code 1で終了します（fail closed）。

**停止方法**: 起動したterminalで `Ctrl-C`。SIGINT / SIGTERMのどちらでも、collectorの
tailを止めてからserverを閉じます（`src/live.ts` のshutdown handler）。残るprocessも
一時fileもありません。

## DEMO（最短手順）

LIVE入力もcredentialも外部networkも使わず、画面の全機能を確認できます。

```bash
npm run demo                            # 1. DEMO storeにfixtureを投入して起動
open http://127.0.0.1:4317/#demo        # 2. ブラウザで開く
# 3. 止めるときは起動したterminalで Ctrl-C（SIGINT / SIGTERMどちらでも停止します）
```

`npm run demo` は `QUEST_DEMO=1` を渡し、`QUEST_INPUT_PATH` が未設定なら `/dev/null` を
使います（既存の値があればそれを優先）。したがってlocal session・credential・network接続は
不要です。DEMO storeへ投入されるのは `src/demo/fixtures.ts` の**固定13 event**だけで、
timerも乱数も外部I/Oも使いません。何度起動しても同じ画面になります。

**このDEMOで確認できること**

| 見えるもの | 内容 |
|---|---|
| 5つのactor状態 | 待機中 `IDLE` / 作業中 `WORKING` / 承認待ち `APPROVAL` / 完了 `ENDED` / エラー `ERROR` が同時に1画面へ並びます |
| 2つのsession | 進行中のsessionと、`session_end` 済みの完了sessionの両方 |
| 接続状態 | `LOADING` → `CONNECTED` の遷移。「再接続」ボタンで `LOADING` からやり直せます |
| LIVE/DEMO分離 | LIVEボタンへ切り替えると席・log・bannerが全て空になります（DEMOのstateは混ざりません） |
| Canvasとの整合 | canvasは装飾層で、DOMの社員一覧・凡例・logが正本です |

DEMOは**読み取り専用**です。画面から任意commandを実行する導線も、DEMO stateを書き換える
導線もありません。DEMO eventがLIVE store / LIVE stream / LIVE stateへ入ることは
構造的に不可能です（`seedDemoStore` はLIVE storeを渡されるとthrowします）。

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
- control frame … `event: snapshot` / `replay_start` / `replay_end` / `stream_gap` / `fail_closed`
  （control frameは **`id:` を持ちません**。clientの `Last-Event-ID` を壊さないためです）

`fail_closed` は、接続中にingestがhaltしたことを伝えるframeです。haltはeventを生まないため、
これがないと接続済みclientはheartbeatを受け続けたまま「接続済み」を表示し続けてしまいます。
payloadは `{ namespace, halted: true, reason, detail }` で、`reason` は
`unsupported_schema` / `state_limit` / `producer_capacity` の閉じた語彙、`detail` は
`/health` の `halt_reason` と同じsanitized断片（`schema_version:<n>`、`<limit>:<max>`、
`producer:limit_reached`）です。stream内容は含みません。
haltは接続中のclientへ一度だけ通知され、`snapshot` を受け取る接続では
`snapshot` の `halted` / `halt_reason` からも判定できます。

### 再接続とreplay

clientが `Last-Event-ID` を送ると:

| 状況 | 応答 |
|------|------|
| そのidがbuffer内にある | `replay_start` → 後続event群 → `replay_end` |
| ingest済みだがbufferから溢れた | `stream_gap`（`reason: "evicted"`）→ `snapshot` |
| このnamespaceで未知のid | `stream_gap`（`reason: "unknown_event_id"`）→ `snapshot` |
| UUIDv4として不正 | `stream_gap`（`reason: "invalid_last_event_id"`）→ `snapshot` |

replay bufferは有界です。gapは黙って埋めず、必ず明示してから現在stateのsnapshotを送ります。

replay経路だけは `snapshot` を送らないため、client切断中にhaltしていた場合は
`replay_end` の**後**に `fail_closed` を1回追加します（同じpayload、`id:` なし）。
これがないと、offline中のhaltを挟んだ再接続でclientが「接続済み」に戻ってしまいます。

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
ingestがhaltしている場合の `取り込み停止 (fail-closed)` を表示します。haltは接続中でも
`fail_closed` frameで即座に伝わり、既知のreasonのみ日本語labelとしてbannerに添えます。
`stream_gap` は黙って埋めず、明示bannerを出してから後続の `snapshot` で復旧します。

#### status banner（閉じた語彙）

画面上部のbannerは `selectBanner()`（`quest-view.js` の純粋関数）が決めます。
**常にちょうど1つ**のcodeが出ており、「何も出ていない状態」はありません。
優先順は上から下で、colorに加えて記号とcodeをtextで併記します。

| code | 記号 | 意味 |
|------|------|------|
| `FAIL_CLOSED` | `✖` | ingestがhalt。表示中のstateは停止時点のまま凍結 |
| `DISCONNECTED` | `✖` | 接続が切れた。「再接続」で復帰 |
| `RECONNECTING` | `◍` | 再接続中。Last-Event-IDから続きを取得 |
| `STREAM_GAP` | `‼` | streamに欠落。後続の `snapshot` で復旧 |
| `REPLAYING` | `◌` | 取りこぼし分をreplay中 |
| `LOADING` | `◌` | streamへ接続中（初回表示・mode切替直後） |
| `EMPTY` | `⋯` | 接続済みだが在席0 |
| `CONNECTED` | `●` | 接続済み・N席のstateを表示中 |

halt reason（`unsupported_schema` / `state_limit` / `producer_capacity`）と
gap reason（`invalid_last_event_id` /
`unknown_event_id` / `evicted`）はどちらも**閉じた語彙**です。既知のtokenだけが日本語labelへ
変換され、未知の文字列はbannerへ出しません（wireの自由記述をそのまま表示しません）。

### Canvas描画（`World → draw(World)`）

DOMの社員カードに加えて、同じstateを**Canvas 2D**のレトロオフィスとしても描画します。
描画層は2つの純粋moduleに閉じています。

| file | 役割 |
|------|------|
| `src/ui/public/quest-world.js` | `selectDesks` / `selectHeader` の出力＋viewportから、描画用 `World` を組む純粋関数 |
| `src/ui/public/quest-canvas.js` | `drawWorld(ctx, world)`。渡された2D context以外に触らない |

- **決定論**: 同じ入力・同じviewportなら、部屋・床・壁・机・キャラクター・labelの座標は常に同一です。
  キャラクターの見た目（肌・髪・髪型・服・ズボン）は `actor_key` のhashから固定パレットを引くので、
  同じactorは常に同じ姿で、乱数もclockも使いません。
- **状態表現**: 5状態それぞれに**形の違うpixel marker**（`▶`＝三角 / `‼`＝感嘆符 / `✖`＝×印 /
  `■`＝四角 / `⋯`＝点列）を頭上に描き、記号と状態codeをtextでも併記します。色だけには依存しません。
- **responsive / DPR**: viewport幅から列数（最大6）とscale（0.25刻み）を決め、部屋がcanvasに
  必ず収まるようにします。bufferは `devicePixelRatio`（1〜4にclamp）倍で確保します。
  CSSは `width:100%; height:auto` だけで、scriptはinline styleを書きません。
- **backing storeの上限**: collectorは `max_actors`（既定4096）まで受け付けるので、席数がそのまま
  canvas高さになるとbrowserが確保できないbufferになります（6列 × 683行 = 3840×125904 device px、
  約4.83億pixel ≒ RGBA 1.9GB）。そこで描画側に決定論的な上限を置いています。

  | 定数 | 値 | 意味 |
  |------|----|------|
  | `MAX_ROWS` | `16` | 描画する席の行数上限（最大6列なので96席） |
  | `MAX_DEVICE_SIDE` | `8192` | backing store 1辺の上限（device px） |
  | `MAX_DEVICE_PIXELS` | `16777216` | backing store 総面積の上限（device px） |

  行数を先にcapしてからscaleを決め、最後に実効device scale（`world.canvas.dpr`）を
  `min(devicePixelRatio, 辺の上限, sqrt(面積の上限 / CSS面積))` へ落とします。上限に当たらない通常の
  officeでは要求DPRがそのまま使われるので、見た目は変わりません。4096席・DPR 4・960×560では
  3840×3240（約1244万pixel ≒ 49.8MB）に収まります。
- **描き切れない席**: 上限を超えた分は黙って落とさず、canvas下部に固定文言＋整数だけで
  `表示 N 席 / 全 M 席 · 残り K 席は下の一覧に表示` と明示します（`world.overflow` は
  `drawn + hidden === total` を常に満たします）。DOMの社員一覧・凡例・logは従来通り**全actor**を
  表示し、そちらがアクセシビリティ正本です。canvasが描くのは先頭からの連続した席で、
  並べ替えも間引きも代替actorの生成もしません。
- **motion**: canvasは**完全に静的**です。timerもanimation frameも使わず、state変化とresize時にだけ
  再描画するので、`prefers-reduced-motion` で止めるものがありません。
- **accessibility**: canvasは `aria-hidden` の装飾層です。社員情報・status label・connection banner・
  凡例・アクティビティログ・LIVE/DEMO切替はこれまで通りDOM側に残り、そちらが正のアクセシビリティ層です。
- **素材**: 外部assetは一切取得しません。すべて矩形と文字だけで描いています。
- canvasが描くのは名前・状態記号・状態codeだけです。raw status label、tool名、`stream_gap` の
  reason文字列といった自由記述はcanvasへ渡らず、従来通りDOM側だけが表示します。

**戻し方**: 描画層だけを外せばPR #4の最小DOM画面に戻ります。
`quest-world.js` / `quest-canvas.js`（と `.d.ts`、`test/ui-world.test.ts`、`test/ui-canvas.test.ts`）を削除し、
`src/ui/assets.ts` のasset table 2行、`index.html` の `#office-canvas-frame` block、
`quest.css` の `.office__canvas*`、`quest-app.js` のcanvas layer block（2つのimportと
`renderCanvas` 呼び出しを含む）を戻すだけです。SSE・client fold・DOM描画には触れていません。

### アクセシビリティ

**DOMが正本、canvasは装飾層**です。canvasは `aria-hidden` で、そこに描かれる事実
（誰が・どの状態か）は必ずDOMの社員一覧・凡例・アクティビティログ・HUDにもあります。
canvasが上限で描き切れない席があっても、DOMの一覧は**常に全actor**を表示します。

| 項目 | 実装 |
|------|------|
| キーボード操作 | 操作はすべてnativeの `<button>` / `<a>`。LIVE/DEMO切替・再接続・skip link・**AI社員の選択**はTabとEnter/Spaceだけで完結します。独自key handlerもcustom widgetもありません |
| 社員の選択 | 社員カードの見出しがnativeの `<button>`（`.desk__select`）です。Tabで全社員に届き、Enter/Spaceで選択・再度押すと解除します。選択状態は `aria-pressed` と `data-selected` で公開し、色だけには依存しません。listenerは一覧に1つのdelegationで、席数が増えても増えません |
| 操作の正本 | 選択はDOM側だけで完結します。canvasにはlistenerを付けず、pointer座標から席を引く処理（hit test）も持ちません。選択中のactorは `actor_key`（`ClientState.selected_actor_key`）で保持し、席番号では保持しません |
| tab順 | `tabindex` は `0` のみ。正の値も `-1` も使わず、scriptがfocusを奪うこともありません |
| scroll領域 | 独自scrollbarを持つのはアクティビティログだけで、その容器が `tabindex="0"` + `aria-labelledby` の名前付きfocus stopです（keyboardだけでscrollできます） |
| focus可視化 | `:focus-visible` のoutlineを1箇所で宣言し、どこでも `outline: none` しません |
| accessible name | 社員一覧・mode group・log領域に名前があります。記号（`✖` `▶` など）はすべて `aria-hidden` の装飾で、隣に必ずtext labelがあります |
| 現在選択 | LIVE/DEMOと社員選択はどちらも `aria-pressed` で状態を公開します（色だけに依存しません） |
| 通知 | live regionは**status bannerの1つだけ**（`role="status"` + `aria-live="polite"`）。接続・再接続・gap・fail-closed・emptyはすべてここへ1回だけ出ます。HUDの数値は同じ事実の静的な再掲なのでlive regionにしていません（二重読み上げ回避） |
| 色以外での識別 | 全状態が「記号 + code + label」を持ちます。bannerの `data-tone` は色だけで、意味はcode/記号側にあります |
| reduced motion | animation / transition は `@media (prefers-reduced-motion: no-preference)` の中だけ。canvasはtimerもanimation frameも使わない完全な静止画です |
| 200% zoom / 狭い画面 | breakpointは1024 / 720 / 480pxの3段。固定幅containerも `min-width` による下限もないため、320 CSS px（＝640px画面の200% zoom）まで横scrollなしで1カラムへreflowします。`user-scalable=no` も `maximum-scale` も指定していません |
| 過剰ARIA回避 | nativeのroleを言い直す `role=` を書きません。live regionは1つだけです |

これらは `test/ui-a11y.test.ts` が配信assetそのものに対して検証しています。

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
| producerのcapacity marker（LIVE） | ingestを即時halt（`producer_capacity`）。markerは正本 `limit_marker_event` の **全フィールド**（固定activity tuple / identity / session / tool / skill / task / outcome残り / workspace すべて `null`）と完全一致した行だけです。markerは業務eventとして畳み込まず、履歴欠落を固定文言で表示 |
| capacity markerの近似行（LIVE） | **haltしない**。1フィールドでも報告している行はその行だけ拒否（`contract_mismatch`）し、後続の正当な業務行はingestを継続。1行のmalformedがsession以降の履歴全体を失わせないため |
| capacity marker形の行が未modelled keyを持つ（LIVE） | **haltしない**。top-level / nestedを問わずdropが1件でもあればmarkerではないと判定し、その行だけ拒否（`contract_mismatch`）。detailにkey名も値も含めない。業務行の未modelled keyは従来どおりdropしてingestを継続（前方互換は業務行のみ） |
| state保持上限に到達（LIVE / DEMO両方） | ingestを即時halt。上限超過のeventは適用せず、既存stateは削除も置換もしない |
| `producer.kind` / `producer.env` 不一致（LIVE） | その行だけ拒否（`unsupported_producer`） |
| `session_id` が `null`（LIVE） | その行だけ拒否（`unattributable`）。sentinelは作らない |
| known table外の `hook_event`（LIVE） | その行だけ拒否（`unsupported_hook_event`）。意味を推測しない |
| `activity` が正本の固定tupleと不一致（LIVE） | その行だけ拒否（`contract_mismatch`）。`activity.label` は自由記述として受理しない。tool行のtupleは正本と同じく **`tool.name` から** 決まります（`Grep`=`search-terminal` / `WebSearch`=`antenna` / `mcp__…`=`portal` / `Skill`=`desk`）。未知名・名前なしは正本と同じ `idle / desk` fallback |
| `tool.mcp_server` が `tool.name` から導かれない（LIVE） | その行だけ拒否（`contract_mismatch` / `tool.mcp_server:not_derived_from_name`）。serverは正本と同じ `^mcp__([A-Za-z0-9_-]{1,64}?)__` の捕獲結果のみで、供給値を分類に使わない |
| `hook_event` とagent identityの矛盾（LIVE） | その行だけ拒否（`identity_conflict`）。`agent.id: null` を無条件に `main` としない |
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
- 外部wireは `src/domain/hookWire.ts` がmodelしたkeyだけを組み立て、`src/domain/hookAdapter.ts` が
  mapping表の行だけを使います。producer objectのspreadはどこでも行いません。
- adapterの出力は内部validatorへ **もう一度** 通します。mappingが変わっても内容規則は効き続けます。
- `agent.type`（runtime agent type）は組織上のroleではないため `agent_role` へ入れません。
  `runtime_agent_type` として別fieldに保持し、roleはActorDirectoryだけが与えます。
- raw prompt、raw command、絶対path、secret/credential、内部reasoningは保存も配信もしません。
  producerが出さないこれらの値を、このrepositoryから追加取得することもありません。
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
- fail-closedの表示は、`snapshot` を受ける接続では `halted` から、接続中のhaltと
  replay経路の再接続では `fail_closed` frameから判定します。どの経路でも表示中のstateは
  消さず、停止時点のまま凍結して表示します。
- 画面はDEMO fixtureで全状態を再現できますが、`state_limit` によるhaltはDEMOでは起こしません
  （DEMOを止めないため）。fail-closed表示自体はtestで検証しています。
- 画面のレンダリングを検証する自動testはDOM contract（要素・selector・状態style・
  reduced-motion）と純粋関数までで、実ブラウザでのpixel比較は行っていません。
- **アクセシビリティのtestは配信assetに対する契約検証まで**です（`test/ui-a11y.test.ts`）。
  実ブラウザでのfocus順、実screen readerでの読み上げ、contrast比の実測、
  実際の200% zoom描画は自動化していません。手動確認が必要です。
- **社員の選択は選択そのものだけです。** 選択してもrequestは1本も増えず、指示送信・行動指定・
  詳細paneの展開はありません（Phase 3の範囲）。選択中のactorが在席しなくなると（`snapshot` で
  officeが差し替わると）選択は自動的に解除され、古い座席が新しいlayoutへ持ち越されることは
  ありません。選択状態はcanvasには反映しません（canvasは装飾層のままです）。
- **本repoはruntime actor（Claude Code session）単位のofficeです。** 組織snapshot、部署、
  社長室フロア、未所属・共用施設といったフロア構成、固定の社員roster、人間playerのactorは
  実装していません。`selectDesks` が席を決めるのはcollectorが解決したactorだけで、
  役職も配属も推測しません。
- 画面の文言は日本語のみです（`<html lang="ja">`）。i18nはMVPの対象外です。
- DEMOは自動進行しません。fixtureは1回投入されて固定で、時間経過で状態が変わることも、
  UIからDEMO stateを変更することもできません。
- Canvas描画のtestは、`World` の決定論・座標の収まり・DPR境界・backing store上限（0/1/40/95/96/97/
  4096席 × DPR 1〜4 × viewport 240〜8192）と、記録用の偽contextに対する `drawWorld` の呼び出し列
  までです。実ブラウザでのpixel比較やfont metricsの検証はしていません。
- canvasのlabel幅は `measureText` ではなく等幅fontを前提とした概算で決めています
  （全角は1em、半角は0.62em）。実際のfontが大きく異なる場合、長い名前の省略位置が
  1〜2文字ずれることがあります。切れて読めなくなるのではなく、省略記号が付きます。
- canvasの席は最大6列・最大16行（96席）です。それを超える席はcanvasには描かれず、件数だけを
  canvas下部に明示します。全actorはDOMの社員一覧に従来通り表示されます。
- 行数が増えて高さがviewportに収まらない場合はcanvas自体が縦に伸び、ページがscrollします
  （96席までは内容が切れることはありません）。
- 非常に大きなviewport（例: 8192×8192）ではbacking storeの面積上限に当たり、実効device scaleが
  1未満まで下がってcanvasがやや甘くなることがあります。表示内容は欠けません。
- canvasの説明labelは名前・状態記号・状態codeだけです。role・last tool・session・最終event時刻は
  従来通りDOM側の社員カードで確認します。
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
