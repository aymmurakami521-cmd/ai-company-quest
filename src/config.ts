/**
 * Environment-driven configuration.
 *
 * The input path is always supplied by the operator through `QUEST_INPUT_PATH`;
 * no personal or absolute path is committed to this repository. The bind host
 * is intentionally NOT configurable - see `server.ts`.
 */

import { DEFAULT_MAX_LINE_BYTES } from './domain/validate.ts';
import { DEFAULT_DEDUPE_CAPACITY, DEFAULT_REPLAY_CAPACITY } from './collector/store.ts';
import { DEFAULT_PORT } from './server/server.ts';

export type QuestConfig = {
  inputPath: string | null;
  port: number;
  replayCapacity: number;
  dedupeCapacity: number;
  pollIntervalMs: number;
  maxLineBytes: number;
  startFrom: 'beginning' | 'end';
  seedDemo: boolean;
  playerName: string;
};

export type EnvLike = Record<string, string | undefined>;

function readInt(env: EnvLike, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: EnvLike): QuestConfig {
  const rawInput = env['QUEST_INPUT_PATH'];
  const inputPath = rawInput === undefined || rawInput.trim() === '' ? null : rawInput.trim();

  const rawStartFrom = env['QUEST_START_FROM'] ?? 'beginning';
  if (rawStartFrom !== 'beginning' && rawStartFrom !== 'end') {
    throw new Error("QUEST_START_FROM must be 'beginning' or 'end'");
  }

  const rawPlayer = env['QUEST_PLAYER_NAME'];
  const playerName = rawPlayer === undefined || rawPlayer.trim() === '' ? 'Player' : rawPlayer.trim().slice(0, 64);

  return {
    inputPath,
    port: readInt(env, 'QUEST_PORT', DEFAULT_PORT, 1024, 65535),
    replayCapacity: readInt(env, 'QUEST_REPLAY_CAPACITY', DEFAULT_REPLAY_CAPACITY, 1, 100_000),
    dedupeCapacity: readInt(env, 'QUEST_DEDUPE_CAPACITY', DEFAULT_DEDUPE_CAPACITY, 1, 5_000_000),
    pollIntervalMs: readInt(env, 'QUEST_POLL_INTERVAL_MS', 100, 10, 60_000),
    maxLineBytes: readInt(env, 'QUEST_MAX_LINE_BYTES', DEFAULT_MAX_LINE_BYTES, 256, 8 * 1024 * 1024),
    startFrom: rawStartFrom,
    seedDemo: env['QUEST_DEMO'] === '1',
    playerName,
  };
}
