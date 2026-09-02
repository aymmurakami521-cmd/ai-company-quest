# Owner ARK 管理画面（Stage A）

Quest #49 Stage A。オーナーが日常的に開き、**AIが何をしようとしているか / いま何をしているか /
自分の判断が必要か / 何が終わったか** を理解するための最小実用面。

Presentation V2（Quest #48）をblockしません。同じread modelの**交換可能な第2projection**です。

```text
same ARK read model (quest-view.js の ClientState)
   ├─ Owner ARK Console  (/ark)  ← 本ドキュメント
   └─ Retro Office / World (/)   ← 既存
```

---

## 1. なぜ別ルートなのか

`/` のレトロオフィス画面は書き換えていません。別ファイル・別ルートにした理由:

1. **落ちる範囲を切る。** canvas / world / 席割りが壊れても、管理機能は生きている
   （Issue #49 受け入れ条件10）。ARK画面はcanvasを一切importしません。
2. **business-state testを書き換えない。** 既存のUI/state testはそのまま通ります
   （同12）。Presentation V2が来ても、ここが読むのは同じ `ClientState` です。
3. **compact要件と診断要件を両立させる。** オフィス画面は診断的な縦長でよく、ARKは
   1画面に収まる必要がある。同じDOMで両立させるより、projectionを2つ持つ方が安い。

---

## 2. ファイル

| ファイル | 役割 |
|---|---|
| `src/ui/public/quest-ark.js` | 純粋なprojection。DOM・socket・時計に触れません |
| `src/ui/public/quest-ark.d.ts` | その契約（実装はbrowserがそのまま読むため素のJS） |
| `src/ui/public/ark.html` | 1画面のDOM。`<details>` drawerで詳細を畳みます |
| `src/ui/public/quest-ark.css` | compact grid。narrow幅で1カラム |
| `src/ui/public/quest-ark-app.js` | SSE frame → view state → DOM。判断は一切しません |
| `test/ui-ark.test.ts` | projectionの契約 |
| `test/ui-ark-dom.test.ts` | 画面の契約（Need You優先度・stale・evidence・compact・no-write） |

---

## 3. 状態を新設しない

ARKは**既存の語彙だけ**を読みます。

| ARKが出すもの | 由来 |
|---|---|
| Need Youの順位 | `ACTOR_VISUAL_STATES`（worst-first。indexがそのままrank） |
| 接続に関するNeed You | `selectBanner` の `FAIL_CLOSED` / `DISCONNECTED` / `RECONNECTING` / `STREAM_GAP` |
| 凍結表示 | `selectDesks` の `stale` / `last_known_visual` |
| Nowの区分 | `ActorVisualState` の1:1 rename（下表） |
| Outcome | `last_known_visual` と `session.ended_at` |

Nowの区分は新しいstate machineではなく、既存stateの読み替えです。

| visual state | Now |
|---|---|
| `error` | `BLOCKED`（停止（エラー）） |
| `awaiting_approval` | `HUMAN_WAIT`（人間待ち） |
| `planning` / `working` | `EXECUTING`（実行中） |
| `ended` | `ENDED`（終了） |
| `idle` | `IDLE`（待機） |
| `unknown` | `UNKNOWN`（状態不明） |

**外部待ち（external wait）は判定しません。** それを示すfieldがevent契約にないため、
「判定できない」と表示します。最終eventからの経過時間から推測することはしません。

---

## 4. Need You は Decision Packet

単なる「承認してください」ではなく、次を持ちます。

- なぜ人が必要か（`reason`）
- 対象（actor / session）
- 推奨判断（`recommended`）
- 選択肢（`options`）— **表示だけです。ボタンではありません**
- 何もしない場合の影響（`inaction`）
- Evidence（後述）
- 最終更新（`last_update`）と、確認済みかどうか（`confirmed`）

### 4.1 required と advised

`required` は run 自身が出した明示的な要求（承認待ち・fail-closed）。
`advised` はそれより弱い（エラー・接続不明）。「誰も今は正常だと言えない」ことと、
「runが判断を求めている」ことは別の主張だからです。`quest-view.js` の `HUMAN_ACTION`
が既に引いている区別と同じものです。

### 4.2 切断はデスクごとに増やさない

stale中は全デスクの `visual` が `unknown` になります。それを1人1件のNeed Youにすると、
隣にある本物の承認待ちが複製の壁に埋もれます。よって切断は **接続itemを1件だけ**出します。

同時に、デスク側のNeed Youは `last_known_visual` から判定します。`visual` で判定すると、
**誰も自分で確認できないその瞬間に**、承認待ちと失敗がNeed Youから消えます。
`representative()` が `quest-view.js` で同じ理由により同じ選択をしています。
消さない代わりに `confirmed: false` を必ず添え、「停止時点: ◯◯」として描画します。

---

## 5. Evidence は2種類

| 種別 | 内容 |
|---|---|
| `trace` | streamが実際に報告したもの（session / actor_key / 最終event種別 / 最後のツール / 生のstatus / 最新の概要 / 最終更新 / 観測event数）。常に到達可能 |
| `artifacts` | tests / CI / PR / commit / 成果物。**現在のwireに存在しません**。空欄ではなく「ありません」と明示します |

空欄は「証拠がなかった」と読まれます。それは「この契約は運んでいない」とは別の主張です。

---

## 6. Next は fail-closed

`selectDetail().next_action` は契約上つねに `null` です。ARKはそれを改善しません。

- 行として出るのは「計画中と報告された」デスクのみ
- その行も「次の具体的な手順は報告されていません」と明示
- Delegation Contractの項目（goal / success condition / planned steps / assignee /
  expected cost / Human Gate）は**項目名だけ**を並べ、値は「現在のevent契約にはありません」

上流契約がそれらを持ったら、ここの値が変わるだけで画面構造は動きません。

---

## 7. 依頼入力は下書きまで

認証済みControl boundaryが存在しないため、ARKは**送信しません**。

```text
Owner ARK UI
  ↓  （ここまでが本Issue Stage A）
authenticated Task / Delegation boundary   ← 未接続
  ↓
Development Autopilot / Controller
  ↓
Claude Code / provider adapter
```

`buildCommandDraft` は入力を検証して typed payload に組み立てるだけの純関数です。

```json
{
  "schema_version": 1,
  "kind": "owner_task_delegation",
  "origin": "owner_ark_console",
  "namespace": "live",
  "intent": "…",
  "target_actor_key": null,
  "drafted_at": "…",
  "dispatch": "none"
}
```

- 拒否理由は閉じた語彙（`empty` / `too_long` / `control_chars`）で、入力を復唱しません
- 送信boxは `NOT_CONNECTED` を常時表示し、送信ボタンは常に `disabled`
- payload自身が `dispatch: "none"` を持つので、画面外へコピーされても誤解されません
- Questにmutating endpointは追加していません。開くrequestは既存のSSE GET 1本だけです

---

## 8. レイアウトの約束

- laptop幅: ページ自体はスクロールせず（`height: 100vh`）、各panelが内側でスクロールします
- 各listは先頭 `ARK_SUMMARY_ROWS` 件のみ表示し、残りは `<details>` drawerへ。
  drawerは中身が無いときは出しません
- 900px以下: 1カラムになり、Need Youが先頭。ページ自体のスクロールを許可します
  （4つのpanelを同時に見せられない幅で、panel内スクロールを重ねる方が悪い）
- 重要情報を色だけで表現しません。level・区分・結果はすべて語と記号とdata属性を伴います
- live regionはbanner 1つだけ。Need Youは頻繁に変わるため、live regionにしません
- motionは0。よって `prefers-reduced-motion` の分岐が要りません

---

## 9. Stage B に残したもの

- 認証済みControl boundaryへの実送信
- Delegation Contract / Work Receipt の実データ
- artifact / test / CI / PR 参照
- 外部待ちの判定
- World projectionとの相互遷移

いずれも、上流契約が来たときに `quest-ark.js` の該当selectorが値を返すようになるだけで、
画面とテストの構造は変わりません。
