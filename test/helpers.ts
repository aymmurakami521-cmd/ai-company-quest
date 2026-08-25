/** Shared test fixtures and tiny HTTP/SSE clients. Not a test file itself. */

import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { SanitizedEvent } from '../src/domain/event.ts';
import type { IngestedEvent } from '../src/domain/reducer.ts';
import { resolveActorFromEvent } from '../src/domain/actor.ts';
import type { Namespace } from '../src/domain/event.ts';

export function makeEvent(overrides: Partial<SanitizedEvent> = {}): SanitizedEvent {
  return {
    schema_version: 2,
    sanitizer_version: 3,
    event_id: randomUUID(),
    session_id: 'sess-1',
    ts: '2026-01-01T00:00:00.000Z',
    event_type: 'agent_start',
    agent_id: 'main',
    agent_role: null,
    producer_seq: null,
    status: null,
    tool_name: null,
    duration_ms: null,
    token_count: null,
    summary: null,
    ...overrides,
  };
}

export function makeLine(overrides: Partial<SanitizedEvent> = {}): string {
  return JSON.stringify(makeEvent(overrides));
}

export function makeIngested(
  event: SanitizedEvent,
  ingestSeq: number,
  namespace: Namespace = 'live',
): IngestedEvent {
  return { namespace, ingest_seq: ingestSeq, event, actor: resolveActorFromEvent(event) };
}

export type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

export function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export type SseClient = {
  status: number;
  headers: IncomingHttpHeaders;
  text: () => string;
  waitFor: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
};

type Waiter = { predicate: (text: string) => boolean; resolve: () => void; timer: ReturnType<typeof setTimeout> };

export function openSse(port: number, path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      const waiters: Waiter[] = [];

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          if (waiter !== undefined && waiter.predicate(text)) {
            clearTimeout(waiter.timer);
            waiters.splice(index, 1);
            waiter.resolve();
          }
        }
      });

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        waitFor: (predicate, timeoutMs = 3000) =>
          new Promise<void>((done, fail) => {
            if (predicate(text)) {
              done();
              return;
            }
            const timer = setTimeout(() => {
              fail(new Error('timed out waiting for SSE content'));
            }, timeoutMs);
            waiters.push({ predicate, resolve: done, timer });
          }),
        close: () => {
          for (const waiter of waiters) clearTimeout(waiter.timer);
          waiters.length = 0;
          res.destroy();
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Counts complete SSE frames (terminated by a blank line). */
export function countFrames(text: string, eventName: string): number {
  const parts = text.split('\n\n');
  // The trailing element is whatever has not been terminated yet.
  return parts.slice(0, -1).filter((frame) => frame.includes(`event: ${eventName}`)).length;
}
