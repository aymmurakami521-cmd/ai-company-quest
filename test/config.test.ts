import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';

test('an absent input path is surfaced as null so LIVE can fail closed', () => {
  assert.equal(loadConfig({}).inputPath, null);
  assert.equal(loadConfig({ QUEST_INPUT_PATH: '   ' }).inputPath, null);
  assert.equal(loadConfig({ QUEST_INPUT_PATH: ' events.jsonl ' }).inputPath, 'events.jsonl');
});

test('defaults are safe and do not embed any personal path', () => {
  const config = loadConfig({});
  assert.equal(config.port, 4317);
  assert.equal(config.startFrom, 'beginning');
  assert.equal(config.seedDemo, false);
  assert.equal(config.playerName, 'Player');
  assert.equal(config.maxLineBytes, 65536);
});

test('invalid numeric configuration is rejected instead of silently defaulted', () => {
  assert.throws(() => loadConfig({ QUEST_PORT: '80' }), /QUEST_PORT/);
  assert.throws(() => loadConfig({ QUEST_PORT: 'abc' }), /QUEST_PORT/);
  assert.throws(() => loadConfig({ QUEST_REPLAY_CAPACITY: '0' }), /QUEST_REPLAY_CAPACITY/);
  assert.throws(() => loadConfig({ QUEST_START_FROM: 'middle' }), /QUEST_START_FROM/);
});

test('demo seeding is opt-in', () => {
  assert.equal(loadConfig({ QUEST_DEMO: '1' }).seedDemo, true);
  assert.equal(loadConfig({ QUEST_DEMO: 'true' }).seedDemo, false);
});

test('the value ledger is a configured path, and no path is a supported mode', () => {
  assert.equal(loadConfig({}).valueLedgerPath, null);
  assert.equal(loadConfig({ QUEST_VALUE_LEDGER_PATH: '  ' }).valueLedgerPath, null);
  assert.equal(
    loadConfig({ QUEST_VALUE_LEDGER_PATH: ' company/value.json ' }).valueLedgerPath,
    'company/value.json',
  );
});

test('amounts are withheld by default, and widening them is explicit', () => {
  // The safe end is the default: a rate policy is commercially sensitive and
  // this process has no identity to check.
  assert.equal(loadConfig({}).valueDisclosure, 'restricted');
  assert.equal(loadConfig({ QUEST_VALUE_DISCLOSURE: 'restricted' }).valueDisclosure, 'restricted');
  assert.equal(loadConfig({ QUEST_VALUE_DISCLOSURE: 'full' }).valueDisclosure, 'full');
});

test('an unrecognised disclosure level fails closed rather than defaulting open', () => {
  assert.throws(() => loadConfig({ QUEST_VALUE_DISCLOSURE: 'Full' }), /QUEST_VALUE_DISCLOSURE/);
  assert.throws(() => loadConfig({ QUEST_VALUE_DISCLOSURE: 'all' }), /QUEST_VALUE_DISCLOSURE/);
  assert.throws(() => loadConfig({ QUEST_VALUE_DISCLOSURE: '1' }), /QUEST_VALUE_DISCLOSURE/);
});
