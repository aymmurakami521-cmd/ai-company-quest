/**
 * End to end for the external LIVE wire.
 *
 * A producer-shaped JSONL file is written to disk, tailed by the collector,
 * validated against the external contract, normalized by the adapter, folded by
 * the shared reducer, streamed over SSE and finally folded again by the client
 * reducer the screen uses. What is pinned here is that the whole path works with
 * real producer records, and that nothing outside the modelled fields reaches
 * the wire, `/health`, the served state or the screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Collector } from '../src/collector/collector.ts';
import { NamespaceStore } from '../src/collector/store.ts';
import { seedDemoStore } from '../src/demo/fixtures.ts';
import { INTERNAL_TASK_EVENT_TYPE } from '../src/domain/hookAdapter.ts';
import { WIRE_EVENT_KEYS } from '../src/domain/wire.ts';
import { QuestServer } from '../src/server/server.ts';
import { applyFrame, createClientState, haltLabel, selectDesks, selectHeader } from '../src/ui/public/quest-view.js';
import { httpGet, makeLine, openSse } from './helpers.ts';
import {
  CAPACITY_MARKER,
  KNOWN_HOOK_EVENT_SEQUENCE,
  SAMPLE_POST_TOOL_USE,
  SAMPLE_SUBAGENT_START,
  hookEventId,
  makeHookEvent,
  makeHookLine,
} from './hookFixtures.ts';

/** A LIVE store configured exactly as `live.ts` configures it. */
function liveStore(): NamespaceStore {
  return new NamespaceStore({
    namespace: 'live',
    inputContract: 'claude_hook_v2',
    failClosedOnUnsupportedSchema: true,
  });
}

/** Writes producer lines to a temp file and tails them through a collector. */
async function ingestThroughTailer(store: NamespaceStore, lines: readonly string[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'quest-hook-'));
  const file = join(dir, 'events.jsonl');
  const collector = new Collector({ store, input: { path: file } });
  try {
    await writeFile(file, `${lines.join('\n')}\n`);
    await collector.tailer.pollOnce();
  } finally {
    await collector.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Folds a live SSE text through the client reducer the screen uses. */
function foldClient(text: string): ReturnType<typeof createClientState> {
  let state = createClientState('live');
  for (const frame of text.split('\n\n').slice(0, -1)) {
    const nameLine = frame.split('\n').find((part) => part.startsWith('event: '));
    const dataLine = frame.split('\n').find((part) => part.startsWith('data: '));
    if (nameLine === undefined || dataLine === undefined) continue;
    // The SSE event name for a quest event; control frames keep their own names.
    const name = nameLine.slice('event: '.length);
    const kind = name === 'quest_event' ? 'event' : name;
    const payload: unknown = JSON.parse(dataLine.slice('data: '.length));
    state = applyFrame(state, { kind, payload, at_ms: 1000 });
  }
  return state;
}

// ------------------------------------------------------- the full LIVE path ---

test('producer records reach the reducer through the tailer, the wire and the adapter', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    makeHookLine({ event_id: hookEventId(1), hook_event: 'SessionStart' }),
    JSON.stringify(SAMPLE_SUBAGENT_START),
    JSON.stringify(SAMPLE_POST_TOOL_USE),
  ]);

  assert.equal(store.stats.lines_seen, 3);
  assert.equal(store.stats.accepted, 3, 'every producer line was accepted');
  assert.equal(store.stats.rejected, 0);
  assert.equal(store.halted, false);

  // The main orchestrator (agent.id null) and the named subagent are separate
  // actors of the same session.
  assert.deepEqual(Object.keys(store.state.sessions), ['sess-1']);
  assert.deepEqual(Object.keys(store.state.actors).sort(), ['sess-1:agent-1', 'sess-1:main']);

  const main = store.state.actors['sess-1:main'];
  assert.equal(main?.is_main_orchestrator, true);
  assert.equal(main?.last_tool, 'Bash', 'the PostToolUse record moved the orchestrator desk');
  assert.equal(main?.status, 'ok');
  assert.equal(main?.role, null, 'no role was invented from a runtime agent type');

  const subagent = store.state.actors['sess-1:agent-1'];
  assert.equal(subagent?.active, true);
  assert.equal(subagent?.status, 'active');
  assert.equal(subagent?.role, null);
});

test('the whole known hook_event table folds without a rejection', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, KNOWN_HOOK_EVENT_SEQUENCE.map((wire) => JSON.stringify(wire)));

  assert.equal(store.stats.accepted, KNOWN_HOOK_EVENT_SEQUENCE.length);
  assert.equal(store.stats.rejected, 0);
  // Claude-internal task bookkeeping is recorded and counted as ignored, never
  // interpreted as company work.
  assert.equal(store.state.counters.by_type[INTERNAL_TASK_EVENT_TYPE], 2);
  assert.equal(store.state.counters.ignored, 2);
});

/** One completed tool call, as the pinned producer classifies that tool. */
function postToolLine(
  index: number,
  toolName: string | null,
  mcpServer: string | null,
  category: string,
  facility: string,
  label: string,
): string {
  return JSON.stringify({
    ...makeHookEvent({ event_id: hookEventId(index), hook_event: 'PostToolUse' }),
    tool: { name: toolName, category, mcp_server: mcpServer, tool_use_id: 'tool-1' },
    activity: { kind: category, facility, label },
    outcome: { status: 'ok', duration_ms: 12, is_interrupt: null, error_kind: null, denial_kind: null },
  });
}

test("every producer tool class folds, and a facility the producer does not emit does not", async () => {
  const store = liveStore();
  // One row per classification rule of the pinned producer: the name table, the
  // two facilities of the `search` category, the MCP prefix rule, the `Skill`
  // row `_safe_facility` rewrites, the Task tools and the unknown-name fallback.
  await ingestThroughTailer(store, [
    postToolLine(61, 'Read', null, 'read', 'shelf', '資料の参照を確認しました'),
    postToolLine(62, 'Grep', null, 'search', 'search-terminal', '検索処理を確認しました'),
    postToolLine(63, 'WebSearch', null, 'search', 'antenna', '外部調査の完了を確認しました'),
    postToolLine(64, 'WebFetch', null, 'search', 'antenna', '外部調査の完了を確認しました'),
    postToolLine(65, 'mcp__github__get_issue', 'github', 'mcp', 'portal', '外部サービスとの通信を確認しました'),
    postToolLine(66, 'Skill', null, 'skill', 'desk', '手順書の実行を確認しました'),
    postToolLine(67, 'TaskCreate', null, 'idle', 'desk', 'ツール処理を確認しました'),
    postToolLine(68, 'SomeFutureTool', null, 'idle', 'desk', 'ツール処理を確認しました'),
    postToolLine(69, null, null, 'idle', 'desk', 'ツール処理を確認しました'),
  ]);

  assert.equal(store.stats.rejected, 0, 'a real Mac hook row must not be refused as a mismatch');
  assert.equal(store.stats.accepted, 9);
  // The last row reports no tool, so the desk keeps the last tool it did report.
  assert.equal(store.state.actors['sess-1:main']?.last_tool, 'SomeFutureTool');
  assert.equal(store.state.actors['sess-1:main']?.status, 'ok');
  assert.equal(store.halted, false);

  // The facilities the consumer previously invented, and the two cross-facility
  // rows a category-keyed table could not tell apart. All fail closed.
  const refused = liveStore();
  await ingestThroughTailer(refused, [
    postToolLine(71, 'mcp__github__get_issue', 'github', 'mcp', 'antenna', '外部サービスとの通信を確認しました'),
    postToolLine(72, 'Skill', null, 'skill', 'portal', '手順書の実行を確認しました'),
    postToolLine(73, 'Grep', null, 'search', 'antenna', '検索処理を確認しました'),
    postToolLine(74, 'WebSearch', null, 'search', 'search-terminal', '外部調査の完了を確認しました'),
    // ...and a plain tool claiming the MCP class to borrow its label.
    postToolLine(75, 'Bash', null, 'mcp', 'portal', '外部サービスとの通信を確認しました'),
  ]);

  assert.equal(refused.stats.accepted, 0);
  assert.equal(refused.stats.rejected_by_reason['contract_mismatch'], 5);
  assert.equal(Object.keys(refused.state.actors).length, 0, 'no desk moved on a mismatched tuple');
  assert.equal(refused.halted, false, 'a mismatched tuple is a per-line rejection');
});

test('producer records reach the screen through SSE, and land on a desk', async () => {
  const live = liveStore();
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);

  try {
    const sse = await openSse(address.port, '/events/live');
    await sse.waitFor((text) => text.includes('event: snapshot'));

    await ingestThroughTailer(live, [JSON.stringify(SAMPLE_SUBAGENT_START), JSON.stringify(SAMPLE_POST_TOOL_USE)]);
    await sse.waitFor((text) => text.includes(SAMPLE_POST_TOOL_USE.event_id));

    const client = foldClient(sse.text());
    const desks = selectDesks(client);
    assert.equal(desks.length, 2, 'the orchestrator and the subagent both have a desk');
    assert.equal(selectHeader(client).session_count, 1);
    assert.equal(selectHeader(client).halted, false);

    const subagentDesk = desks.find((desk) => desk.display_name === 'agent-1');
    assert.ok(subagentDesk !== undefined, 'the subagent desk exists');
    // The producer reported a runtime agent type for this subagent. It is a
    // runtime configuration, not an org role, so the desk stays unresolved and
    // the screen never renders it as one.
    assert.equal(subagentDesk.role, null);
    assert.equal(subagentDesk.resolved, false);
    assert.equal(JSON.stringify(desks).includes('backend-engineer'), false);
    // The label is the producer's own fixed phrase, unchanged.
    assert.ok(sse.text().includes('専門Agentが起動しました'));

    sse.close();
  } finally {
    await server.close();
  }
});

// ------------------------------------------------------- nothing else leaks ---

test('no external field outside the mapping reaches the wire, health or the state', async () => {
  const live = liveStore();
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);

  try {
    const sse = await openSse(address.port, '/events/live');
    await sse.waitFor((text) => text.includes('event: snapshot'));

    await ingestThroughTailer(live, [JSON.stringify(SAMPLE_SUBAGENT_START), JSON.stringify(SAMPLE_POST_TOOL_USE)]);
    await sse.waitFor((text) => text.includes(SAMPLE_POST_TOOL_USE.event_id));

    const streamText = sse.text();
    const health = await httpGet(address.port, '/health');
    const surfaces = [streamText, health.body];

    // Every external value this repository deliberately drops. None of them may
    // appear on any surface a consumer can read.
    const dropped = [
      SAMPLE_POST_TOOL_USE.producer.host_id,
      SAMPLE_POST_TOOL_USE.prompt_id,
      SAMPLE_POST_TOOL_USE.tool.tool_use_id,
      SAMPLE_POST_TOOL_USE.tool.category,
      SAMPLE_POST_TOOL_USE.workspace.repo_id,
      SAMPLE_POST_TOOL_USE.workspace.bucket,
      SAMPLE_POST_TOOL_USE.activity.facility,
      SAMPLE_SUBAGENT_START.activity.facility,
    ];
    for (const value of dropped) {
      assert.ok(typeof value === 'string' && value.length > 0, 'the fixture actually carries the value');
      for (const surface of surfaces) {
        assert.equal(surface.includes(value), false, `dropped value '${value}' must not be published`);
      }
    }
    // The raw hook event name is not a company concept either: only the
    // normalized `event_type` is published.
    for (const surface of surfaces) {
      assert.equal(surface.includes('PostToolUse'), false);
      assert.equal(surface.includes('SubagentStart'), false);
    }

    // And structurally: every streamed event object carries exactly the wire
    // whitelist, so a future producer field cannot ride along unnoticed.
    const allowed = new Set(WIRE_EVENT_KEYS);
    const eventFrames = streamText
      .split('\n\n')
      .slice(0, -1)
      .filter((frame) => frame.includes('event: quest_event'));
    assert.equal(eventFrames.length, 2);
    for (const frame of eventFrames) {
      const dataLine = frame.split('\n').find((part) => part.startsWith('data: '));
      assert.ok(dataLine !== undefined);
      const payload = JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
      for (const key of Object.keys(payload)) assert.ok(allowed.has(key), `unexpected wire key ${key}`);
    }

    sse.close();
  } finally {
    await server.close();
  }
});

test('a refused line publishes a reason and a field, never the value that failed', async () => {
  const store = liveStore();
  const secret = 'sk-ant-aaaaaaaaaaaaaaaaaaaa';
  await ingestThroughTailer(store, [
    JSON.stringify(
      makeHookEvent({
        event_id: hookEventId(31),
        hook_event: 'PostToolUse',
        activity: { kind: 'exec', facility: 'terminal', label: `used ${secret}` },
      }),
    ),
  ]);

  assert.equal(store.stats.accepted, 0);
  assert.equal(store.stats.rejected, 1);
  assert.equal(store.stats.rejected_by_reason['unsafe_content'], 1);
  assert.equal(JSON.stringify(store.stats).includes('sk-ant'), false);
  assert.equal(store.halted, false, 'one bad line must not freeze the stream');
});

test('an arbitrary label never reaches the state, the wire, /health or the screen', async () => {
  const live = liveStore();
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);

  // Control-free, no absolute path, no credential, under the length bound: the
  // shape a raw prompt or a command echoed into a label would have.
  const arbitrary = 'echo the customer discussion';

  try {
    const sse = await openSse(address.port, '/events/live');
    await sse.waitFor((text) => text.includes('event: snapshot'));

    await ingestThroughTailer(live, [
      JSON.stringify({
        ...makeHookEvent({ event_id: hookEventId(81), hook_event: 'PostToolUse' }),
        activity: { kind: 'exec', facility: 'terminal', label: arbitrary },
      }),
      // A second row whose label is a real producer phrase, but from another
      // event. A valid phrase is still not valid here.
      JSON.stringify({
        ...makeHookEvent({ event_id: hookEventId(82), hook_event: 'SessionStart' }),
        activity: { kind: 'session', facility: 'desk', label: 'セッションが終了しました' },
      }),
      JSON.stringify(makeHookEvent({ event_id: hookEventId(83), hook_event: 'SessionStart' })),
    ]);
    await sse.waitFor((text) => text.includes(hookEventId(83)));

    assert.equal(live.stats.accepted, 1, 'only the well formed row was folded');
    assert.equal(live.stats.rejected_by_reason['contract_mismatch'], 2);
    assert.equal(live.halted, false, 'a mismatched label is a per-line rejection');

    const health = await httpGet(address.port, '/health');
    const client = foldClient(sse.text());
    for (const surface of [sse.text(), health.body, JSON.stringify(live.state), JSON.stringify(client)]) {
      assert.equal(surface.includes(arbitrary), false, 'the arbitrary label must not be published');
      assert.equal(surface.includes('セッションが終了しました'), false, 'the misplaced phrase must not be published');
    }
    // And the rejection accounting names the rule, never the value.
    assert.equal(JSON.stringify(live.stats).includes(arbitrary), false);

    sse.close();
  } finally {
    await server.close();
  }
});

test('an identity conflict is refused end to end, and moves no desk', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    // A subagent lifecycle row with no subagent: it must not become the desk of
    // the main orchestrator.
    JSON.stringify(
      makeHookEvent({
        event_id: hookEventId(91),
        hook_event: 'SubagentStart',
        agent: { id: null, type: null, parent_session_id: null },
      }),
    ),
    // A main-only row carrying a subagent id.
    JSON.stringify(
      makeHookEvent({
        event_id: hookEventId(92),
        hook_event: 'Stop',
        agent: { id: 'agent-1', type: 'backend-engineer', parent_session_id: null },
      }),
    ),
    // The valid pair still folds: one main desk, one subagent desk.
    JSON.stringify(makeHookEvent({ event_id: hookEventId(93), hook_event: 'SessionStart' })),
    JSON.stringify(makeHookEvent({ event_id: hookEventId(94), hook_event: 'SubagentStart' })),
  ]);

  assert.equal(store.stats.rejected_by_reason['identity_conflict'], 2);
  assert.equal(store.stats.accepted, 2);
  assert.deepEqual(Object.keys(store.state.actors).sort(), ['sess-1:agent-1', 'sess-1:main']);
  assert.equal(store.state.actors['sess-1:main']?.is_main_orchestrator, true);
  assert.equal(store.state.actors['sess-1:agent-1']?.active, true);
  assert.equal(store.halted, false);
});

// --------------------------------------------------------------- fail closed ---

test('an unattributable record is refused, and never becomes a desk', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    JSON.stringify(makeHookEvent({ event_id: hookEventId(41), hook_event: 'SessionStart', session_id: null })),
    JSON.stringify(makeHookEvent({ event_id: hookEventId(42), hook_event: 'SessionStart' })),
  ]);

  assert.equal(store.stats.accepted, 1);
  assert.equal(store.stats.rejected_by_reason['unattributable'], 1);
  assert.deepEqual(Object.keys(store.state.sessions), ['sess-1'], 'no sentinel session was created');
  assert.equal(Object.keys(store.state.actors).length, 1);
});

test('an unknown hook_event is refused rather than folded as an unknown type', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    JSON.stringify(makeHookEvent({ event_id: hookEventId(51), hook_event: 'SomethingNew' })),
  ]);

  assert.equal(store.stats.accepted, 0);
  assert.equal(store.stats.rejected_by_reason['unsupported_hook_event'], 1);
  assert.equal(Object.keys(store.state.actors).length, 0);
});

test('the flat internal model is refused by a LIVE store, and does not halt it', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [makeLine(), makeLine({ event_type: 'tool_use', tool_name: 'read' })]);

  assert.equal(store.stats.accepted, 0, 'a flat event is not the external contract');
  assert.equal(store.stats.rejected, 2);
  assert.equal(store.stats.rejected_by_reason['missing_key'], 2);
  assert.equal(store.halted, false, 'the wrong shape is a rejection, not a schema halt');
});

test('an unsupported external schema_version halts LIVE ingestion', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    JSON.stringify({ ...makeHookEvent({ event_id: hookEventId(61) }), schema_version: 3 }),
    JSON.stringify(makeHookEvent({ event_id: hookEventId(62), hook_event: 'SessionStart' })),
  ]);

  assert.equal(store.halted, true);
  assert.equal(store.stats.halt_reason, 'unsupported_schema:schema_version:3');
  assert.equal(store.stats.accepted, 0, 'nothing after the halt is ingested');
});

test('the capacity marker freezes the stream and is announced as a fixed phrase', async () => {
  const live = liveStore();
  const demo = new NamespaceStore({ namespace: 'demo' });
  const server = new QuestServer({ stores: { live, demo }, heartbeatMs: 60_000 });
  const address = await server.listen(0);

  try {
    const sse = await openSse(address.port, '/events/live');
    await sse.waitFor((text) => text.includes('event: snapshot'));

    await ingestThroughTailer(live, [
      JSON.stringify(makeHookEvent({ event_id: hookEventId(71), hook_event: 'SessionStart' })),
      JSON.stringify(CAPACITY_MARKER),
      JSON.stringify(makeHookEvent({ event_id: hookEventId(72), hook_event: 'PostToolUse' })),
    ]);
    await sse.waitFor((text) => text.includes('event: fail_closed'));

    assert.equal(live.halted, true);
    assert.equal(live.stats.halt_reason, 'producer_capacity:producer:limit_reached');
    assert.equal(live.stats.accepted, 1, 'the marker is not folded, and nothing after it is read');
    assert.equal(live.state.counters.by_type['capacity'], undefined);

    // `/health` publishes the boundary fact, with no stream content in it.
    const health = await httpGet(address.port, '/health');
    const body = JSON.parse(health.body) as { status: string; namespaces: Record<string, { halt_reason: string }> };
    assert.equal(body.status, 'fail_closed');
    assert.equal(body.namespaces['live']?.halt_reason, 'producer_capacity:producer:limit_reached');
    assert.equal(health.body.includes(CAPACITY_MARKER.activity.label), false, 'the marker label is not published');

    // The screen labels the halt from its own closed vocabulary.
    const client = foldClient(sse.text());
    assert.equal(selectHeader(client).halted, true);
    assert.equal(selectHeader(client).halt_reason, 'producer_capacity');
    assert.equal(haltLabel('producer_capacity'), '記録側の容量上限に達し、以降の履歴が欠落しています');

    sse.close();
  } finally {
    await server.close();
  }
});

test('only the exact capacity row halts LIVE; a near miss is refused line by line', async () => {
  const store = liveStore();
  await ingestThroughTailer(store, [
    // Right kind and status, wrong facility.
    JSON.stringify({
      ...CAPACITY_MARKER,
      event_id: hookEventId(101),
      activity: { kind: 'capacity', facility: 'portal', label: CAPACITY_MARKER.activity.label },
    }),
    // Right kind, facility and status, a label the producer does not emit.
    JSON.stringify({
      ...CAPACITY_MARKER,
      event_id: hookEventId(102),
      activity: { kind: 'capacity', facility: 'desk', label: '記録容量の上限に達しました' },
    }),
    // A capacity row that claims a session and a subagent.
    JSON.stringify({
      ...CAPACITY_MARKER,
      event_id: hookEventId(103),
      session_id: 'sess-1',
      agent: { id: 'agent-1', type: null, parent_session_id: null },
    }),
    JSON.stringify(makeHookEvent({ event_id: hookEventId(104), hook_event: 'SessionStart' })),
  ]);

  assert.equal(store.halted, false, 'a near miss must not be read as the capacity marker');
  assert.equal(store.stats.rejected_by_reason['contract_mismatch'], 3);
  assert.equal(store.stats.accepted, 1, 'the stream continued past the refused rows');

  // The real marker, on the other hand, still stops everything.
  const halting = liveStore();
  await ingestThroughTailer(halting, [JSON.stringify(CAPACITY_MARKER)]);
  assert.equal(halting.halted, true);
  assert.equal(halting.stats.halt_reason, 'producer_capacity:producer:limit_reached');
});

// ------------------------------------------------------------- LIVE vs DEMO ---

test('DEMO keeps its own contract, and the two stores never share one', async () => {
  const live = liveStore();
  const demo = new NamespaceStore({ namespace: 'demo', inputContract: 'internal_normalized' });

  const seeded = seedDemoStore(demo);
  assert.ok(seeded > 0, 'the DEMO fixtures still fold through the internal model');
  assert.equal(demo.stats.rejected, 0);
  assert.equal(live.stats.lines_seen, 0, 'seeding DEMO touched nothing in LIVE');

  // A producer record is not DEMO input, and a DEMO fixture is not LIVE input.
  assert.equal(demo.ingestObject(SAMPLE_POST_TOOL_USE).status, 'rejected');
  await ingestThroughTailer(live, [JSON.stringify(SAMPLE_POST_TOOL_USE)]);
  assert.equal(live.stats.accepted, 1);
  assert.equal(Object.keys(live.state.sessions).includes('demo-session-01'), false);
});
