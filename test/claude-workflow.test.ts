/**
 * Regression cover for .github/workflows/claude.yml.
 *
 * Issue #14: the issues trigger listed `opened` and the assign event. The
 * guard decides whether to run from the issue body and title alone and never
 * reads the assignee, so assigning an issue re-evaluated identical input and
 * started a second, duplicate implementation run. These tests pin the trigger
 * surface, and with it the safety boundary around the trigger -- the
 * deny-by-default token, the actor gate, the fork rejection, the concurrency
 * group, the bot allow-list, and the per-job permissions -- so that neither
 * can be widened again without a test failing.
 *
 * The repository carries no dependencies and this file adds none, so the
 * workflow is read with a small block-YAML reader covering exactly the subset
 * the file uses: block mappings, block sequences, flow sequences, and block
 * scalars. Structure is asserted against that reading rather than against a
 * text match, so reformatting the workflow does not fake a pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface Cursor {
  lines: string[];
  index: number;
}

/** Drop a trailing `#` comment, ignoring one inside a quoted scalar. */
function stripComment(line: string): string {
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single) double = !double;
    else if (ch === '#' && !single && !double && (i === 0 || /\s/.test(line.charAt(i - 1)))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Advance past blank and comment-only lines; neither ends a block in YAML. */
function skipBlanks(cursor: Cursor): void {
  while (cursor.index < cursor.lines.length) {
    const raw = cursor.lines[cursor.index] ?? '';
    if (stripComment(raw).trim() !== '') return;
    cursor.index += 1;
  }
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseInline(value: string): YamlNode {
  if (value === '{}') return {};
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => unquote(item.trim()));
  }
  return unquote(value);
}

/**
 * Consume a `|`/`>` block scalar: every following line indented deeper than
 * the key, blank lines included, dedented by the common indent.
 */
function readBlockScalar(cursor: Cursor, keyIndent: number): string {
  const body: string[] = [];
  while (cursor.index < cursor.lines.length) {
    const raw = cursor.lines[cursor.index] ?? '';
    if (raw.trim() !== '' && indentOf(raw) <= keyIndent) break;
    body.push(raw);
    cursor.index += 1;
  }
  while (body.length > 0 && (body[body.length - 1] ?? '').trim() === '') body.pop();
  const common = body
    .filter((line) => line.trim() !== '')
    .reduce((min, line) => Math.min(min, indentOf(line)), Number.MAX_SAFE_INTEGER);
  return body.map((line) => line.slice(Math.min(common, line.length))).join('\n');
}

function parseMapping(cursor: Cursor, indent: number): { [key: string]: YamlNode } {
  const mapping: { [key: string]: YamlNode } = {};
  for (;;) {
    skipBlanks(cursor);
    const raw = cursor.lines[cursor.index];
    if (raw === undefined) break;
    const lineIndent = indentOf(raw);
    if (lineIndent < indent) break;
    const text = stripComment(raw).trim();
    const match = /^([^:#\s]+):(?:\s+(.*))?$/.exec(text);
    if (lineIndent > indent || match === null) {
      throw new Error(`unexpected line ${cursor.index + 1}: ${raw}`);
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    cursor.index += 1;
    if (value === '') mapping[key] = parseChild(cursor, indent);
    else if (value === '|' || value === '>') mapping[key] = readBlockScalar(cursor, indent);
    else mapping[key] = parseInline(value);
  }
  return mapping;
}

function parseSequence(cursor: Cursor, indent: number): YamlNode[] {
  const items: YamlNode[] = [];
  for (;;) {
    skipBlanks(cursor);
    const raw = cursor.lines[cursor.index];
    if (raw === undefined) break;
    const lineIndent = indentOf(raw);
    const text = stripComment(raw).trim();
    if (lineIndent !== indent || !(text === '-' || text.startsWith('- '))) break;
    const rest = text === '-' ? '' : text.slice(2).trim();
    if (rest === '') {
      cursor.index += 1;
      items.push(parseChild(cursor, indent));
      continue;
    }
    if (/^[^:#\s]+:(\s|$)/.test(rest)) {
      // `- key: value` opens a mapping whose remaining keys sit at the item's
      // content indent. Restate the first key at that indent and read on.
      const contentIndent = lineIndent + 2;
      cursor.lines[cursor.index] = ' '.repeat(contentIndent) + rest;
      items.push(parseMapping(cursor, contentIndent));
      continue;
    }
    cursor.index += 1;
    items.push(parseInline(rest));
  }
  return items;
}

function parseChild(cursor: Cursor, parentIndent: number): YamlNode {
  skipBlanks(cursor);
  const raw = cursor.lines[cursor.index];
  if (raw === undefined) return '';
  const lineIndent = indentOf(raw);
  const text = stripComment(raw).trim();
  const isItem = text === '-' || text.startsWith('- ');
  // A block sequence may sit at the parent key's own indent; a mapping may not.
  if (lineIndent < parentIndent || (lineIndent === parentIndent && !isItem)) return '';
  return isItem ? parseSequence(cursor, lineIndent) : parseMapping(cursor, lineIndent);
}

function parseYaml(source: string): { [key: string]: YamlNode } {
  return parseMapping({ lines: source.split('\n'), index: 0 }, 0);
}

function asMapping(node: YamlNode | undefined, path: string): { [key: string]: YamlNode } {
  if (node === undefined || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${path} is not a mapping`);
  }
  return node;
}

function asSequence(node: YamlNode | undefined, path: string): YamlNode[] {
  if (!Array.isArray(node)) throw new Error(`${path} is not a sequence`);
  return node;
}

function asScalar(node: YamlNode | undefined, path: string): string {
  if (typeof node !== 'string') throw new Error(`${path} is not a scalar`);
  return node;
}

/**
 * Locate the trigger block whatever the loader called it.
 *
 * YAML 1.1 folds a bare `on` key to the boolean true, YAML 1.2 keeps it a
 * string, so the same file is filed under "on" by one loader and under "true"
 * by another. A test hard-coding one spelling passes silently when the block
 * it meant to inspect is not there at all, so accept every spelling and reject
 * a file that somehow carries more than one.
 */
function readTriggers(workflow: { [key: string]: YamlNode }): { [key: string]: YamlNode } {
  const spellings = ['on', 'true', 'True', 'TRUE'].filter((key) =>
    Object.prototype.hasOwnProperty.call(workflow, key),
  );
  if (spellings.length === 0) throw new Error('no `on` block in the workflow');
  if (spellings.length > 1) throw new Error(`more than one \`on\` block: ${spellings.join(', ')}`);
  return asMapping(workflow[spellings[0] ?? ''], '`on`');
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/claude.yml', import.meta.url));
const SOURCE = readFileSync(WORKFLOW_PATH, 'utf8');
const WORKFLOW = parseYaml(SOURCE);
const TRIGGERS = readTriggers(WORKFLOW);
const JOBS = asMapping(WORKFLOW['jobs'], 'jobs');

test('the issues trigger fires on opened only', () => {
  assert.deepEqual(asMapping(TRIGGERS['issues'], '`on`.issues'), { types: ['opened'] });
});

test('the assign event is gone from the whole workflow, comments included', () => {
  // The duplicate run came from one word in one list. A structural check on
  // `on`.issues alone would miss it being reintroduced under another event, so
  // this reads the file as text: the token must appear nowhere at all.
  assert.equal(/\bassigned\b/i.test(SOURCE), false);
  for (const [event, node] of Object.entries(TRIGGERS)) {
    const types = asSequence(asMapping(node, `\`on\`.${event}`)['types'], `\`on\`.${event}.types`);
    assert.equal(types.includes('assigned'), false, `${event} still lists the assign event`);
  }
});

test('the comment and review trigger paths are untouched', () => {
  assert.deepEqual(Object.keys(TRIGGERS).sort(), [
    'issue_comment',
    'issues',
    'pull_request_review',
    'pull_request_review_comment',
  ]);
  assert.deepEqual(asMapping(TRIGGERS['issue_comment'], '`on`.issue_comment'), {
    types: ['created'],
  });
  assert.deepEqual(
    asMapping(TRIGGERS['pull_request_review_comment'], '`on`.pull_request_review_comment'),
    { types: ['created'] },
  );
  assert.deepEqual(asMapping(TRIGGERS['pull_request_review'], '`on`.pull_request_review'), {
    types: ['submitted'],
  });
});

test('the workflow still starts from a deny-by-default token', () => {
  assert.deepEqual(asMapping(WORKFLOW['permissions'], 'permissions'), {});
});

test('one implementation run at a time per issue or pull request', () => {
  assert.deepEqual(asMapping(WORKFLOW['concurrency'], 'concurrency'), {
    group:
      'claude-impl-${{ github.repository }}-' +
      '${{ github.event.issue.number || github.event.pull_request.number }}',
    'cancel-in-progress': 'false',
  });
});

test('the guard still gates on actor and on an explicit trigger phrase', () => {
  const guard = asMapping(JOBS['guard'], 'jobs.guard');
  assert.equal(
    squash(asScalar(guard['if'], 'jobs.guard.if')),
    [
      '( github.actor == github.repository_owner ||',
      "github.actor == 'chatgpt-codex-connector[bot]' ||",
      "github.actor == 'chatgpt-codex-connector' ) && (",
      "(github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||",
      "(github.event_name == 'pull_request_review_comment' &&",
      "contains(github.event.comment.body, '@claude')) ||",
      "(github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude')) ||",
      "(github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') ||",
      "contains(github.event.issue.title, '@claude'))) )",
    ].join(' '),
  );
});

test('the guard still refuses a fork head branch before any write token exists', () => {
  const guard = asMapping(JOBS['guard'], 'jobs.guard');
  const steps = asSequence(guard['steps'], 'jobs.guard.steps');
  assert.equal(steps.length, 1);
  const resolve = asMapping(steps[0], 'jobs.guard.steps[0]');
  assert.equal(asScalar(resolve['id'], 'jobs.guard.steps[0].id'), 'resolve');
  const script = asScalar(resolve['run'], 'jobs.guard.steps[0].run');
  assert.match(script, /if \[ "\$head_repo" = "\$REPO" \] && \[ -n "\$head_repo" \]/);
  assert.match(script, /allowed=false/);
  assert.match(script, /Pull requests from forks are not given a write token\./);
  // The issues path has no head branch of its own and must stay pinned to this
  // repository, or the fork check above would compare against an empty string.
  assert.match(script, /issues\)\n\s+number="\$ISSUE_NUMBER"\n\s+head_repo="\$REPO"/);
  assert.equal(asScalar(asMapping(JOBS['claude'], 'jobs.claude')['if'], 'jobs.claude.if'),
    "needs.guard.outputs.allowed == 'true'");
});

test('only the named Codex bot is allowed through as a non-human actor', () => {
  const steps = asSequence(asMapping(JOBS['claude'], 'jobs.claude')['steps'], 'jobs.claude.steps');
  const action = steps
    .map((step, i) => asMapping(step, `jobs.claude.steps[${i}]`))
    .find((step) => step['uses'] === 'anthropics/claude-code-action@v1');
  assert.notEqual(action, undefined, 'the Claude action step is missing');
  const inputs = asMapping(asMapping(action, 'action step')['with'], 'jobs.claude action `with`');
  assert.equal(
    asScalar(inputs['allowed_bots'], 'allowed_bots'),
    'chatgpt-codex-connector[bot],chatgpt-codex-connector',
  );
});

test('no job grants itself more than it already had', () => {
  assert.deepEqual(Object.keys(JOBS).sort(), ['claude', 'guard']);
  assert.deepEqual(asMapping(asMapping(JOBS['guard'], 'jobs.guard')['permissions'], 'guard perms'), {
    contents: 'read',
    'pull-requests': 'read',
  });
  assert.deepEqual(
    asMapping(asMapping(JOBS['claude'], 'jobs.claude')['permissions'], 'claude perms'),
    {
      contents: 'write',
      'pull-requests': 'write',
      issues: 'write',
      'id-token': 'write',
      actions: 'read',
    },
  );
});

test('the trigger block is found however the loader spells the `on` key', () => {
  const triggers: YamlNode = { issues: { types: ['opened'] } };
  assert.deepEqual(readTriggers({ on: triggers }), triggers);
  assert.deepEqual(readTriggers({ true: triggers }), triggers);
  assert.throws(() => readTriggers({ name: 'Claude Code' }), /no `on` block/);
  assert.throws(() => readTriggers({ on: triggers, true: triggers }), /more than one/);
});
