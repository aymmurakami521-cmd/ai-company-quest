/**
 * External LIVE wire contract (Claude Code hook, schema_version 2).
 *
 * These tests pin two things: the producer's own records are accepted, and the
 * boundary stays fail-closed for everything else - including the flat internal
 * model, which carries the same version number and must never be mistaken for
 * this contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import type { HookFacility, HookToolCategory } from '../src/domain/hookWire.ts';
import {
  HOOK_FIXED_ACTIVITY,
  HOOK_MCP_TOOL_CLASS,
  HOOK_POST_TOOL_LABELS,
  HOOK_PRE_TOOL_LABELS,
  HOOK_RESEARCH_POST_LABEL,
  HOOK_RESEARCH_PRE_LABEL,
  HOOK_TOOL_CATEGORIES,
  HOOK_TOOL_CLASS,
  HOOK_TOOL_FAILURE_LABEL,
  HOOK_TOOL_FALLBACK_CLASS,
  HOOK_TOOL_PHASES,
  HOOK_WIRE_KEYS,
  hookMcpServer,
  hookToolClass,
  validateHookWireLine,
  validateHookWireObject,
} from '../src/domain/hookWire.ts';
import { HOOK_EVENT_LIFECYCLE } from '../src/domain/hookAdapter.ts';
import { validateEventObject } from '../src/domain/validate.ts';
import { makeEvent } from './helpers.ts';
import {
  CAPACITY_MARKER,
  KNOWN_HOOK_EVENT_SEQUENCE,
  SAMPLE_POST_TOOL_USE,
  SAMPLE_SUBAGENT_START,
  makeHookEvent,
  makeHookLine,
} from './hookFixtures.ts';

test('the producer records published with the contract are accepted', () => {
  for (const sample of [SAMPLE_POST_TOOL_USE, SAMPLE_SUBAGENT_START]) {
    const result = validateHookWireObject(sample);
    assert.equal(result.ok, true, `${sample.hook_event ?? 'null'} must validate`);
    if (!result.ok) continue;
    assert.deepEqual(result.dropped_keys, [], 'the contract models every key the producer emits');
    assert.equal(result.wire.event_id, sample.event_id);
    assert.equal(result.wire.activity.label, sample.activity.label);
  }
});

test('every row of the known hook_event table validates, and so does the capacity marker', () => {
  for (const wire of [...KNOWN_HOOK_EVENT_SEQUENCE, CAPACITY_MARKER]) {
    assert.equal(validateHookWireObject(wire).ok, true, `${wire.hook_event ?? 'capacity marker'} must validate`);
  }
});

// ------------------------------------------------- the two schema_version 2s ---

test('the flat internal model is refused by the external wire validator', () => {
  const result = validateHookWireObject(makeEvent());
  assert.equal(result.ok, false, 'a flat schema_version 2 event is not a hook wire event');
  if (!result.ok) {
    // The first key the flat model does not carry. Nothing about the payload is
    // guessed from its shape: it simply fails the contract it was handed to.
    assert.equal(result.reason, 'missing_key');
    assert.equal(result.detail, 'producer:absent');
  }
});

test('a hook wire event is refused by the internal normalized validator', () => {
  const result = validateEventObject(SAMPLE_POST_TOOL_USE);
  assert.equal(result.ok, false, 'the rich shape is not the internal model');
  if (!result.ok) assert.equal(result.reason, 'missing_key');
});

// --------------------------------------------------------------- fail closed ---

test('an unsupported schema_version is refused before anything is interpreted', () => {
  for (const schemaVersion of [1, 3, 0]) {
    const result = validateHookWireObject({ ...makeHookEvent(), schema_version: schemaVersion });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unsupported_schema');
  }
});

test('sanitizer_version never gates acceptance', () => {
  for (const sanitizerVersion of [0, 3, 4, 99]) {
    const result = validateHookWireObject(makeHookEvent({ sanitizer_version: sanitizerVersion }));
    assert.equal(result.ok, true, `sanitizer_version ${sanitizerVersion} must be accepted`);
    if (result.ok) assert.equal(result.wire.sanitizer_version, sanitizerVersion);
  }
});

test('a payload that does not identify as a local Claude Code hook is refused', () => {
  const wrongKind = validateHookWireObject(
    makeHookEvent({ producer: { kind: 'something-else', host_id: '0123456789ab', env: 'local' } }),
  );
  assert.equal(wrongKind.ok, false);
  if (!wrongKind.ok) {
    assert.equal(wrongKind.reason, 'unsupported_producer');
    assert.equal(wrongKind.detail, 'producer.kind:not_allowed');
  }

  const wrongEnv = validateHookWireObject(
    makeHookEvent({ producer: { kind: 'claude-code-hook', host_id: '0123456789ab', env: 'cloud' } }),
  );
  assert.equal(wrongEnv.ok, false);
  if (!wrongEnv.ok) assert.equal(wrongEnv.reason, 'unsupported_producer');
});

test('every top-level contract key is mandatory', () => {
  for (const key of HOOK_WIRE_KEYS) {
    if (key === 'schema_version') continue;
    const raw: Record<string, unknown> = { ...makeHookEvent() };
    delete raw[key];
    const result = validateHookWireObject(raw);
    assert.equal(result.ok, false, `${key} must be mandatory`);
    if (!result.ok) {
      assert.equal(result.reason, 'missing_key');
      assert.equal(result.detail, `${key}:absent`);
    }
  }
});

test('a missing nested key is reported by path, and refused', () => {
  const result = validateHookWireObject(
    makeHookEvent({ outcome: { status: 'ok', duration_ms: null, is_interrupt: null, error_kind: null } as never }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'missing_key');
    assert.equal(result.detail, 'outcome.denial_kind:absent');
  }
});

test('values outside a closed vocabulary are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ session: { source: 'teleport', end_reason: null } }, 'session.source:not_in_vocabulary'],
    [{ tool: { name: null, category: 'telepathy', mcp_server: null, tool_use_id: null } }, 'tool.category:not_in_vocabulary'],
    [{ activity: { kind: 'daydream', facility: 'desk', label: 'x' } }, 'activity.kind:not_in_vocabulary'],
    [{ activity: { kind: 'exec', facility: 'rooftop', label: 'x' } }, 'activity.facility:not_in_vocabulary'],
    [
      { outcome: { status: 'maybe', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null } },
      'outcome.status:not_in_vocabulary',
    ],
  ];
  for (const [override, detail] of cases) {
    const result = validateHookWireObject({ ...makeHookEvent(), ...override });
    assert.equal(result.ok, false, `${detail} must be refused`);
    if (!result.ok) {
      assert.equal(result.reason, 'invalid_format');
      assert.equal(result.detail, detail);
    }
  }
});

test('malformed scalars are refused', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ event_id: 'not-a-uuid' }, 'invalid_format'],
    // Valid UUID shape but version 1.
    [{ event_id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6' }, 'invalid_format'],
    // Uppercase is not the canonical lowercase form the producer emits.
    [{ event_id: '3F2C9D10-8B41-4A7E-9C02-5F1D7A6B2E88' }, 'invalid_format'],
    [{ ts: '2026-08-22T05:40:00Z' }, 'invalid_format'],
    [{ ts: '2026-08-22T05:40:00.123+09:00' }, 'invalid_format'],
    [{ ts: 42 }, 'type_error'],
    [{ session_id: 'sess 1' }, 'invalid_format'],
    [{ hook_event: 'Post_Tool_Use' }, 'invalid_format'],
    [{ truncated: true }, 'invalid_format'],
    [{ producer: { kind: 'claude-code-hook', host_id: 'nothex', env: 'local' } }, 'invalid_format'],
    [{ agent: { id: null, type: null, parent_session_id: 'sess-0' } }, 'invalid_format'],
  ];
  for (const [override, reason] of cases) {
    const result = validateHookWireObject({ ...makeHookEvent(), ...override });
    assert.equal(result.ok, false, `${JSON.stringify(override)} must be refused`);
    if (!result.ok) assert.equal(result.reason, reason, `${JSON.stringify(override)} -> ${result.detail}`);
  }
});

test('duration_ms is bounded by the producer range', () => {
  const overRange = validateHookWireObject(
    makeHookEvent({
      outcome: { status: 'ok', duration_ms: 86_400_001, is_interrupt: null, error_kind: null, denial_kind: null },
    }),
  );
  assert.equal(overRange.ok, false);
  if (!overRange.ok) assert.equal(overRange.detail, 'outcome.duration_ms:out_of_range');

  for (const durationMs of [0, 1234, 86_400_000]) {
    const result = validateHookWireObject(
      makeHookEvent({
        hook_event: 'PostToolUse',
        outcome: { status: 'ok', duration_ms: durationMs, is_interrupt: null, error_kind: null, denial_kind: null },
      }),
    );
    assert.equal(result.ok, true, `${durationMs} ms must be accepted`);
  }
});

test('unsafe content anywhere in a retained field is refused, and never echoed', () => {
  const unsafeLabels = [
    'read /Users/someone/secrets.txt',
    'opened ~/.ssh/id_rsa',
    'key sk-ant-abcdefghijklmnop',
    'ran sudo rm -rf something',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const label of unsafeLabels) {
    const result = validateHookWireObject(makeHookEvent({ activity: { kind: 'exec', facility: 'terminal', label } }));
    assert.equal(result.ok, false, `must refuse: ${label.slice(0, 12)}`);
    if (!result.ok) {
      assert.equal(result.reason, 'unsafe_content');
      assert.equal(result.detail.includes(label), false, 'the detail must not echo content');
    }
  }
});

test('a control character in a label is refused', () => {
  const result = validateHookWireObject(
    makeHookEvent({ activity: { kind: 'exec', facility: 'terminal', label: 'line\nbreak' } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail, 'activity.label:control_characters');
});

test('unmodelled producer keys are dropped by path, never forwarded', () => {
  const raw: Record<string, unknown> = {
    ...makeHookEvent(),
    future_top_level: 'ignored',
    outcome: {
      status: 'started',
      duration_ms: null,
      is_interrupt: null,
      error_kind: null,
      denial_kind: null,
      future_nested: 'ignored',
    },
  };
  const result = validateHookWireObject(raw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.dropped_keys.sort(), ['future_top_level', 'outcome.future_nested']);
  assert.equal(Object.prototype.hasOwnProperty.call(result.wire, 'future_top_level'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.wire.outcome, 'future_nested'), false);
});

test('a validated wire event carries exactly the modelled keys', () => {
  const result = validateHookWireObject(SAMPLE_POST_TOOL_USE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.wire).sort(), [...HOOK_WIRE_KEYS].sort());
});

// --------------------------------------------------- the fixed activity table ---

/**
 * The pinned producer's non-tool tuples, restated verbatim so that changing the
 * table in `hookWire.ts` cannot silently change what the boundary accepts.
 * `[hook_event, kind, facility, label, outcome.status]`.
 */
const FIXED_TUPLES: ReadonlyArray<[string, string, string, string, string]> = [
  ['SessionStart', 'session', 'desk', 'セッションが開始されました', 'started'],
  ['SessionEnd', 'session', 'desk', 'セッションが終了しました', 'ok'],
  ['SubagentStart', 'delegate', 'meeting', '専門Agentが起動しました', 'started'],
  ['SubagentStop', 'delegate', 'meeting', '専門Agentの処理が終了しました', 'ok'],
  ['UserPromptSubmit', 'idle', 'desk', 'イベントを記録しました', 'started'],
  ['Stop', 'session', 'desk', '応答処理が終了しました', 'ok'],
  ['StopFailure', 'session', 'desk', 'APIエラーで応答が終了しました', 'error'],
  ['PermissionRequest', 'permission', 'desk', '権限確認が発生しました', 'waiting'],
  ['PermissionDenied', 'permission', 'desk', '自動モードで実行が許可されませんでした', 'auto_denied'],
  ['Notification', 'session', 'desk', '通知が発生しました', 'waiting'],
  ['PreCompact', 'session', 'desk', 'コンテキスト整理が開始されました', 'started'],
  ['TaskCreated', 'task', 'desk', '内部タスクが作成されました', 'started'],
  ['TaskCompleted', 'task', 'desk', '内部タスクが完了しました', 'ok'],
];

/** Builds a row for `hookEvent` with an explicit activity tuple. */
function withActivity(
  hookEvent: string | null,
  kind: string,
  facility: string,
  label: string,
  status: string,
): unknown {
  return {
    ...makeHookEvent({ hook_event: hookEvent }),
    activity: { kind, facility, label },
    outcome: { status, duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
  };
}

test('each pinned producer tuple is accepted for its own event', () => {
  for (const [hookEvent, kind, facility, label, status] of FIXED_TUPLES) {
    const result = validateHookWireObject(withActivity(hookEvent, kind, facility, label, status));
    assert.equal(result.ok, true, `${hookEvent} must be accepted with its own tuple`);
    if (result.ok) assert.equal(result.wire.activity.label, label);
  }
});

test('an arbitrary control-free label is refused for every known hook_event', () => {
  // Nothing unsafe about these strings: they are bounded, control-free and hit
  // no path/credential rule. They are refused because they are not the phrase
  // the producer emits for the event - a raw prompt or command reads like this.
  const arbitrary = ['echo the customer discussion', 'summarize the meeting notes', '顧客との会話を整理して'];
  for (const [hookEvent, kind, facility, , status] of FIXED_TUPLES) {
    for (const label of arbitrary) {
      const result = validateHookWireObject(withActivity(hookEvent, kind, facility, label, status));
      assert.equal(result.ok, false, `${hookEvent} must refuse an arbitrary label`);
      if (result.ok) continue;
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, 'activity.label:not_fixed_for_event');
      assert.equal(result.detail.includes(label), false, 'the detail names the rule, not the value');
    }
  }
});

test('a genuine producer phrase is refused on another event', () => {
  for (const [hookEvent, kind, facility, , status] of FIXED_TUPLES) {
    for (const [otherEvent, , , otherLabel] of FIXED_TUPLES) {
      if (otherEvent === hookEvent) continue;
      const result = validateHookWireObject(withActivity(hookEvent, kind, facility, otherLabel, status));
      // A tuple is only equal to itself: some pairs differ on the label, and the
      // pairs that share one differ on kind, facility or status.
      if (result.ok) {
        const expected = FIXED_TUPLES.find((row) => row[0] === hookEvent);
        assert.ok(expected !== undefined);
        assert.equal(result.wire.activity.label, expected[3], `${otherEvent} label leaked onto ${hookEvent}`);
        continue;
      }
      assert.equal(result.reason, 'contract_mismatch');
    }
  }
});

test('a mismatched kind, facility or status is refused, not just a mismatched label', () => {
  const cases: Array<[unknown, string]> = [
    [withActivity('SessionStart', 'task', 'desk', 'セッションが開始されました', 'started'), 'activity.kind'],
    [withActivity('SessionStart', 'session', 'meeting', 'セッションが開始されました', 'started'), 'activity.facility'],
    [withActivity('SessionStart', 'session', 'desk', 'セッションが開始されました', 'ok'), 'outcome.status'],
  ];
  for (const [raw, field] of cases) {
    const result = validateHookWireObject(raw);
    assert.equal(result.ok, false, `${field} must be correlated`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, `${field}:not_fixed_for_event`);
    }
  }
});

// ------------------------------------------------------------- tool activity ---

type ToolRow = {
  hookEvent: string;
  toolName: string | null;
  mcpServer?: string | null;
  category: HookToolCategory;
  facility: HookFacility;
  label: string;
  status: string;
};

/** A tool row, with every correlated field written out rather than derived. */
function toolRow(row: ToolRow): unknown {
  return {
    ...makeHookEvent({ hook_event: row.hookEvent }),
    tool: {
      name: row.toolName,
      category: row.category,
      mcp_server: row.mcpServer ?? null,
      tool_use_id: 'tool-1',
    },
    activity: { kind: row.category, facility: row.facility, label: row.label },
    outcome: { status: row.status, duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null },
  };
}

/** The phase-specific `(hook_event, status)` pairs a tool row is emitted with. */
const TOOL_PHASES: ReadonlyArray<['pre' | 'post' | 'failure', string, string]> = [
  ['pre', 'PreToolUse', 'started'],
  ['post', 'PostToolUse', 'ok'],
  ['failure', 'PostToolUseFailure', 'error'],
];

/** The label the producer emits for one tool name in one phase. */
function expectedLabel(phase: 'pre' | 'post' | 'failure', toolName: string | null, category: HookToolCategory): string {
  if (phase === 'failure') return HOOK_TOOL_FAILURE_LABEL;
  const isResearch = toolName === 'WebSearch' || toolName === 'WebFetch';
  if (phase === 'pre') {
    if (isResearch) return HOOK_RESEARCH_PRE_LABEL;
    const label = HOOK_PRE_TOOL_LABELS.get(category);
    assert.ok(label !== undefined, `${category} must have a pre label`);
    return label;
  }
  if (isResearch) return HOOK_RESEARCH_POST_LABEL;
  const label = HOOK_POST_TOOL_LABELS.get(category);
  assert.ok(label !== undefined, `${category} must have a post label`);
  return label;
}

/**
 * The pinned producer's `TOOL_CATEGORY` table, written out by hand.
 *
 * Deliberately not derived from `HOOK_TOOL_CLASS`: this is the copy of the
 * producer source, so editing the module alone makes this test fail.
 */
const PRODUCER_TOOL_TABLE: ReadonlyArray<[string, HookToolCategory, HookFacility]> = [
  ['Read', 'read', 'shelf'],
  ['Glob', 'read', 'shelf'],
  ['Write', 'write', 'desk'],
  ['Edit', 'write', 'desk'],
  ['NotebookEdit', 'write', 'desk'],
  ['Bash', 'exec', 'terminal'],
  ['PowerShell', 'exec', 'terminal'],
  ['Grep', 'search', 'search-terminal'],
  ['WebSearch', 'search', 'antenna'],
  ['WebFetch', 'search', 'antenna'],
  ['Agent', 'delegate', 'meeting'],
  // `skill / workshop` upstream; `_safe_facility` rewrites it before emission.
  ['Skill', 'skill', 'desk'],
  ['TaskCreate', 'idle', 'desk'],
  ['TaskUpdate', 'idle', 'desk'],
  ['TaskGet', 'idle', 'desk'],
  ['TaskList', 'idle', 'desk'],
  ['TaskStop', 'idle', 'desk'],
  ['TaskOutput', 'idle', 'desk'],
];

test("the tool class table is the pinned producer's, name by name", () => {
  assert.deepEqual(
    [...HOOK_TOOL_CLASS.entries()].map(([name, cls]) => [name, cls.category, cls.facility]),
    PRODUCER_TOOL_TABLE.map((row) => [...row]),
    'the consumer table must be the producer table',
  );
  assert.deepEqual(HOOK_MCP_TOOL_CLASS, { category: 'mcp', facility: 'portal' });
  assert.deepEqual(HOOK_TOOL_FALLBACK_CLASS, { category: 'idle', facility: 'desk' });

  // The classification a real row goes through, including the two rules that a
  // category-keyed facility table could not express.
  assert.deepEqual(hookToolClass('Grep'), { category: 'search', facility: 'search-terminal' });
  assert.deepEqual(hookToolClass('WebFetch'), { category: 'search', facility: 'antenna' });
  assert.deepEqual(hookToolClass('mcp__github__get_issue'), { category: 'mcp', facility: 'portal' });
  assert.deepEqual(hookToolClass('SomeFutureTool'), { category: 'idle', facility: 'desk' });
  assert.deepEqual(hookToolClass(null), { category: 'idle', facility: 'desk' });
});

test("the MCP server is derived from the tool name by the producer's own regex", () => {
  // The producer's `RE_MCP_SERVER`, applied to the name and to nothing else.
  assert.equal(hookMcpServer('mcp__github__get_issue'), 'github');
  assert.equal(hookMcpServer('mcp__my-server_2__do'), 'my-server_2');
  // Lazy quantifier, exactly as upstream: the first segment is the server.
  assert.equal(hookMcpServer('mcp__a__b__tool'), 'a');
  // A segment of exactly 64 characters is the longest the producer captures.
  const longest = 'a'.repeat(64);
  assert.equal(hookMcpServer(`mcp__${longest}__do`), longest);
  // At 65 the pattern no longer matches, so the producer emits no server at all
  // and the name goes through the ordinary unknown-name fallback.
  assert.equal(hookMcpServer(`mcp__${'a'.repeat(65)}__do`), null);
  assert.deepEqual(hookToolClass(`mcp__${'a'.repeat(65)}__do`), HOOK_TOOL_FALLBACK_CLASS);
  // Incomplete or malformed prefixes are not the MCP form.
  for (const name of ['mcp__github', 'mcp__', 'mcp____x', 'Xmcp__github__get_issue', 'Bash']) {
    assert.equal(hookMcpServer(name), null, `${name} is not the producer's MCP form`);
    assert.notDeepEqual(hookToolClass(name), HOOK_MCP_TOOL_CLASS, `${name} must not classify as MCP`);
  }
  assert.equal(hookMcpServer(null), null);
});

test('a supplied mcp_server that the name does not derive is refused', () => {
  const detail = 'tool.mcp_server:not_derived_from_name';
  const mcpName = 'mcp__github__get_issue';
  const mcpLabel = expectedLabel('pre', mcpName, 'mcp');
  const execLabel = expectedLabel('pre', 'Bash', 'exec');
  const idleLabel = expectedLabel('pre', 'SomeFutureTool', 'idle');

  const mcp = { category: 'mcp' as const, facility: 'portal' as const, label: mcpLabel };
  const idle = { category: 'idle' as const, facility: 'desk' as const, label: idleLabel };
  const pre = { hookEvent: 'PreToolUse', status: 'started' };

  const refused: Array<[ToolRow, string]> = [
    // A valid MCP name whose server is missing, different, or invented.
    [{ ...pre, ...mcp, toolName: mcpName, mcpServer: null }, 'a null server'],
    [{ ...pre, ...mcp, toolName: mcpName, mcpServer: 'gitlab' }, 'a different server'],
    [{ ...pre, ...mcp, toolName: mcpName, mcpServer: 'github__get_issue' }, 'a greedier capture'],
    // A plain tool carrying a server: the producer emits null for it.
    [
      { ...pre, toolName: 'Bash', mcpServer: 'github', category: 'exec', facility: 'terminal', label: execLabel },
      'a non-MCP name with a server',
    ],
    // An incomplete prefix, both as MCP and as the fallback it really is.
    [{ ...pre, ...mcp, toolName: 'mcp__github', mcpServer: 'github' }, 'an incomplete prefix claiming MCP'],
    [{ ...pre, ...idle, toolName: 'mcp__github', mcpServer: 'github' }, 'an incomplete prefix with a server'],
    // Over-long server segment: not the MCP form, so not an MCP row.
    [
      { ...pre, ...idle, toolName: `mcp__${'a'.repeat(65)}__do`, mcpServer: 'a'.repeat(65) },
      'a 65-character segment',
    ],
  ];

  for (const [row, description] of refused) {
    const result = validateHookWireObject(toolRow(row));
    assert.equal(result.ok, false, `${description} must be refused`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, detail);
      // Content-free: neither the name nor the supplied server appears.
      assert.equal(result.detail.includes('github'), false);
      assert.equal(result.detail.includes('mcp__'), false);
    }
  }

  // A non-tool event reports no tool, and therefore no server either.
  const sessionRow = validateHookWireObject({
    ...makeHookEvent({ hook_event: 'SessionStart' }),
    tool: { name: null, category: null, mcp_server: 'github', tool_use_id: null },
  });
  assert.equal(sessionRow.ok, false, 'a session row must not carry an MCP server');
  if (!sessionRow.ok) assert.equal(sessionRow.detail, detail);

  // The pairs the producer really emits still pass.
  for (const [phase, hookEvent, status] of TOOL_PHASES) {
    const exact = validateHookWireObject(
      toolRow({
        hookEvent,
        toolName: 'mcp__github__get_issue',
        mcpServer: 'github',
        category: 'mcp',
        facility: 'portal',
        label: expectedLabel(phase, 'mcp__github__get_issue', 'mcp'),
        status,
      }),
    );
    assert.equal(exact.ok, true, `${hookEvent}: the exact name/server pair must be accepted`);
    if (exact.ok) assert.equal(exact.wire.tool.mcp_server, 'github');
  }

  // An incomplete prefix with a null server is an ordinary unknown name.
  const fallback = validateHookWireObject(
    toolRow({
      hookEvent: 'PreToolUse',
      toolName: 'mcp__github',
      mcpServer: null,
      category: 'idle',
      facility: 'desk',
      label: idleLabel,
      status: 'started',
    }),
  );
  assert.equal(fallback.ok, true, 'an incomplete prefix takes the idle/desk fallback');
});

test("every producer tool name is accepted with exactly its own tuple, in every phase", () => {
  for (const [toolName, category, facility] of PRODUCER_TOOL_TABLE) {
    for (const [phase, hookEvent, status] of TOOL_PHASES) {
      const label = expectedLabel(phase, toolName, category);
      const ok = validateHookWireObject(toolRow({ hookEvent, toolName, category, facility, label, status }));
      assert.equal(ok.ok, true, `${hookEvent} ${toolName} must accept its own tuple`);
      if (ok.ok) assert.equal(ok.wire.activity.label, label);
    }
  }
});

test('a tool row that claims another name\'s category or facility is refused', () => {
  for (const [toolName, category, facility] of PRODUCER_TOOL_TABLE) {
    for (const [otherName, otherCategory, otherFacility] of PRODUCER_TOOL_TABLE) {
      const label = expectedLabel('pre', toolName, category);

      // The other tool's category, carried by this name.
      if (otherCategory !== category) {
        const crossedCategory = validateHookWireObject(
          toolRow({
            hookEvent: 'PreToolUse',
            toolName,
            category: otherCategory,
            facility: otherFacility,
            label: expectedLabel('pre', otherName, otherCategory),
            status: 'started',
          }),
        );
        assert.equal(crossedCategory.ok, false, `${toolName} must not pass as ${otherCategory}`);
        if (!crossedCategory.ok) assert.equal(crossedCategory.detail, 'tool.category:not_fixed_for_tool');
      }

      // The same category from a different facility: this is what the previous
      // category-keyed table got wrong for `search`.
      if (otherFacility !== facility && otherCategory === category) {
        const crossedFacility = validateHookWireObject(
          toolRow({ hookEvent: 'PreToolUse', toolName, category, facility: otherFacility, label, status: 'started' }),
        );
        assert.equal(crossedFacility.ok, false, `${toolName} must not sit in ${otherFacility}`);
        if (!crossedFacility.ok) assert.equal(crossedFacility.detail, 'activity.facility:not_fixed_for_tool');
      }

      // The other tool's label, on this tool's otherwise correct row.
      const otherLabel = expectedLabel('pre', otherName, otherCategory);
      if (otherLabel !== label) {
        const crossedLabel = validateHookWireObject(
          toolRow({ hookEvent: 'PreToolUse', toolName, category, facility, label: otherLabel, status: 'started' }),
        );
        assert.equal(crossedLabel.ok, false, `${otherName}'s label must not pass as ${toolName}'s`);
        if (!crossedLabel.ok) assert.equal(crossedLabel.detail, 'activity.label:not_fixed_for_tool');
      }
    }

    // And a phase's label does not travel to another phase.
    const wrongPhase = validateHookWireObject(
      toolRow({
        hookEvent: 'PreToolUse',
        toolName,
        category,
        facility,
        label: expectedLabel('post', toolName, category),
        status: 'started',
      }),
    );
    assert.equal(wrongPhase.ok, false, `${toolName}: a post label must not pass as a pre label`);
    if (!wrongPhase.ok) assert.equal(wrongPhase.detail, 'activity.label:not_fixed_for_tool');
  }
});

test('the facilities the previous category-keyed table got wrong are now refused', () => {
  // `mcp -> antenna` and `skill -> portal` were consumer inventions. The pinned
  // producer emits `mcp -> portal` and `skill -> desk`.
  const wrong: Array<[string, HookToolCategory, HookFacility]> = [
    ['mcp__github__get_issue', 'mcp', 'antenna'],
    ['Skill', 'skill', 'portal'],
    // `search` is not one facility: Grep is not in the research facility, and
    // the research tools are not at the search terminal.
    ['Grep', 'search', 'antenna'],
    ['WebSearch', 'search', 'search-terminal'],
  ];
  for (const [toolName, category, facility] of wrong) {
    const result = validateHookWireObject(
      toolRow({
        hookEvent: 'PreToolUse',
        toolName,
        mcpServer: category === 'mcp' ? 'github' : null,
        category,
        facility,
        label: expectedLabel('pre', toolName, category),
        status: 'started',
      }),
    );
    assert.equal(result.ok, false, `${toolName} must not be accepted in ${facility}`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, 'activity.facility:not_fixed_for_tool');
    }
  }
});

test('an MCP tool is classified by its name prefix and its server, not by a claim', () => {
  for (const [phase, hookEvent, status] of TOOL_PHASES) {
    const label = expectedLabel(phase, 'mcp__github__get_issue', 'mcp');
    const ok = validateHookWireObject(
      toolRow({
        hookEvent,
        toolName: 'mcp__github__get_issue',
        mcpServer: 'github',
        category: 'mcp',
        facility: 'portal',
        label,
        status,
      }),
    );
    assert.equal(ok.ok, true, `${hookEvent}: a real MCP row must be accepted`);
  }

  // A plain tool cannot claim the MCP class to borrow its facility and label.
  const forged = validateHookWireObject(
    toolRow({
      hookEvent: 'PreToolUse',
      toolName: 'Bash',
      category: 'mcp',
      facility: 'portal',
      label: expectedLabel('pre', 'Bash', 'mcp'),
      status: 'started',
    }),
  );
  assert.equal(forged.ok, false, 'a non-MCP name must not pass as MCP');
  if (!forged.ok) assert.equal(forged.detail, 'tool.category:not_fixed_for_tool');

  // And an MCP row cannot be presented as an ordinary one.
  const downgraded = validateHookWireObject(
    toolRow({
      hookEvent: 'PreToolUse',
      toolName: 'mcp__github__get_issue',
      mcpServer: 'github',
      category: 'exec',
      facility: 'terminal',
      label: expectedLabel('pre', 'Bash', 'exec'),
      status: 'started',
    }),
  );
  assert.equal(downgraded.ok, false, 'an MCP row must not pass as exec');
  if (!downgraded.ok) assert.equal(downgraded.detail, 'tool.category:not_fixed_for_tool');
});

test("an unknown or absent tool name takes the producer's idle/desk fallback", () => {
  for (const toolName of ['SomeFutureTool', null]) {
    for (const [phase, hookEvent, status] of TOOL_PHASES) {
      const ok = validateHookWireObject(
        toolRow({
          hookEvent,
          toolName,
          category: 'idle',
          facility: 'desk',
          label: expectedLabel(phase, toolName, 'idle'),
          status,
        }),
      );
      assert.equal(ok.ok, true, `${hookEvent} ${toolName ?? 'no tool'} must take the fallback`);
    }

    // The fallback is a class, not a free pass: it carries only its own label.
    const arbitrary = validateHookWireObject(
      toolRow({
        hookEvent: 'PreToolUse',
        toolName,
        category: 'idle',
        facility: 'desk',
        label: 'echo the customer discussion',
        status: 'started',
      }),
    );
    assert.equal(arbitrary.ok, false, 'the fallback must not accept an arbitrary label');
    if (!arbitrary.ok) assert.equal(arbitrary.detail, 'activity.label:not_fixed_for_tool');

    // ...and an unknown name cannot claim a known tool's class.
    const claimed = validateHookWireObject(
      toolRow({
        hookEvent: 'PreToolUse',
        toolName,
        category: 'exec',
        facility: 'terminal',
        label: expectedLabel('pre', 'Bash', 'exec'),
        status: 'started',
      }),
    );
    assert.equal(claimed.ok, false, 'an unclassified tool must not pass as exec');
    if (!claimed.ok) assert.equal(claimed.detail, 'tool.category:not_fixed_for_tool');
  }
});

test('a tool row without a category is refused rather than labelled generically', () => {
  for (const hookEvent of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const noCategory = validateHookWireObject({
      ...makeHookEvent({ hook_event: hookEvent }),
      tool: { name: 'Bash', category: null, mcp_server: null, tool_use_id: null },
    });
    assert.equal(noCategory.ok, false);
    if (!noCategory.ok) assert.equal(noCategory.detail, 'tool.category:required_for_tool_event');
  }
});

test('the activity table and the lifecycle table describe the same known events', () => {
  const activityEvents = [...HOOK_FIXED_ACTIVITY.keys(), ...HOOK_TOOL_PHASES.keys()].sort();
  assert.deepEqual(activityEvents, [...HOOK_EVENT_LIFECYCLE.keys()].sort(), 'no known event may lack a fixed tuple');

  for (const category of HOOK_TOOL_CATEGORIES) {
    assert.ok(HOOK_PRE_TOOL_LABELS.has(category), `${category} needs a pre label`);
    assert.ok(HOOK_POST_TOOL_LABELS.has(category), `${category} needs a post label`);
  }

  // Every category the producer can classify a tool into is reachable by name.
  const reachable = new Set<HookToolCategory>([
    ...[...HOOK_TOOL_CLASS.values()].map((cls) => cls.category),
    HOOK_MCP_TOOL_CLASS.category,
    HOOK_TOOL_FALLBACK_CLASS.category,
  ]);
  assert.deepEqual([...reachable].sort(), [...HOOK_TOOL_CATEGORIES].sort(), 'every category needs a tool name');
});

// ---------------------------------------------------------- capacity marker ---

test("the capacity control row is accepted only in the producer's exact shape", () => {
  assert.equal(validateHookWireObject(CAPACITY_MARKER).ok, true, 'the pinned marker must validate');

  const fixedLabel = '本日の記録上限に達しました';
  const variants: Array<[Record<string, unknown>, string]> = [
    [
      { activity: { kind: 'capacity', facility: 'portal', label: fixedLabel } },
      'activity.facility:not_fixed_for_capacity',
    ],
    [
      { activity: { kind: 'capacity', facility: 'desk', label: '記録容量の上限に達しました' } },
      'activity.label:not_fixed_for_capacity',
    ],
    [{ activity: { kind: 'session', facility: 'desk', label: fixedLabel } }, 'activity.kind:not_fixed_for_capacity'],
    [
      { outcome: { status: 'ok', duration_ms: null, is_interrupt: null, error_kind: null, denial_kind: null } },
      'outcome.status:not_fixed_for_capacity',
    ],
    [{ session_id: 'sess-1' }, 'session_id:expected_null_for_capacity'],
    [{ agent: { id: 'agent-1', type: null, parent_session_id: null } }, 'agent.id:expected_null_for_capacity'],
    [
      { agent: { id: null, type: 'backend-engineer', parent_session_id: null } },
      'agent.type:expected_null_for_capacity',
    ],
  ];
  for (const [override, detail] of variants) {
    const result = validateHookWireObject({ ...CAPACITY_MARKER, ...override });
    assert.equal(result.ok, false, `${detail} must be refused`);
    if (!result.ok) {
      assert.equal(result.reason, 'contract_mismatch');
      assert.equal(result.detail, detail);
    }
  }
});

// ------------------------------------------------------------------- lines ---

test('line-level failures are refused before parsing or interpretation', () => {
  assert.equal(validateHookWireLine('{"schema_version":2').ok, false);
  assert.equal(validateHookWireLine('not json at all').ok, false);
  assert.equal(validateHookWireLine('[1,2,3]').ok, false);
  assert.equal(validateHookWireLine('null').ok, false);

  const blank = validateHookWireLine('   ');
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.equal(blank.reason, 'blank');

  const oversized = validateHookWireLine(makeHookLine(), { maxLineBytes: 16 });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.reason, 'oversized_line');
});

test('a rejection detail never contains a value from the line', () => {
  const result = validateHookWireLine('{"schema_version":2,"secret":"sk-ant-aaaaaaaaaaaaaaaa"}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.detail.includes('sk-ant'), false);
});
