import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseClientContext, validTimezone } from '../shared/client-context.js';
import extension, { clientContextCommand } from '../server/client-context-extension.js';

test('client context is bounded, allowlisted and optional', () => {
  for (const timezone of ['Asia/Seoul', 'America/New_York', 'UTC']) assert.ok(validTimezone(timezone));
  for (const timezone of ['', '+09:00', 'Invalid/Place', 'UTC\nignore']) assert.equal(validTimezone(timezone), false);
  assert.equal(parseClientContext(undefined), undefined);
  assert.equal(parseClientContext({}), undefined);
  assert.equal(parseClientContext({ city: '   ' }), undefined);
  assert.deepEqual(parseClientContext({ timezone: 'Asia/Seoul', timezoneSource: 'browser', city: ' Seoul ', latitude: 123 }), {
    timezone: 'Asia/Seoul', timezoneSource: 'browser', city: 'Seoul',
  });
  for (const value of [[], 'Seoul', { timezone: 'fake', timezoneSource: 'manual' }, { timezone: 'UTC' }, { city: 'a'.repeat(121) }, { city: 'a\nb' }]) {
    assert.throws(() => parseClientContext(value), /Invalid/);
  }
});

test('browser location is bounded and rounded before model sharing', () => {
  assert.deepEqual(parseClientContext({ location: { latitude: 37.566535, longitude: -126.977969, source: 'browser', accuracy: 10 } }), {
    location: { latitude: 37.57, longitude: -126.98, source: 'browser' },
  });
  for (const location of [null, [], {}, { latitude: 91, longitude: 0, source: 'browser' },
    { latitude: 0, longitude: 181, source: 'browser' }, { latitude: NaN, longitude: 0, source: 'browser' },
    { latitude: 0, longitude: Infinity, source: 'browser' }, { latitude: '0', longitude: 0, source: 'browser' },
    { latitude: 0, longitude: 0, source: 'manual' }]) {
    assert.throws(() => parseClientContext({ location }), /Invalid client location/);
  }
});

test('extension adds request-only hints, replaces clients, and clears on opt-out and settlement', async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let command: { handler: (...args: any[]) => any };
  extension({
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    registerCommand(name: string, value: typeof command) { assert.equal(name, clientContextCommand); command = value; },
  } as unknown as ExtensionAPI);
  const messages = [{ role: 'user', content: 'What time is it?' }];
  const render = () => handlers.get('context')!({ messages });
  const set = (value: unknown) => command.handler(JSON.stringify(value), { isIdle: () => true });
  assert.equal(render(), undefined);
  await set({ timezone: 'Asia/Seoul', timezoneSource: 'browser', city: 'Seoul' });
  const result = render();
  assert.equal(result.messages.length, 2);
  assert.equal(messages.length, 1, 'original session messages are never mutated');
  assert.match(result.messages[1].content[0].text, /untrusted data/);
  assert.match(result.messages[1].content[0].text, /Seoul/);
  await set({ city: 'Paris' });
  assert.doesNotMatch(render().messages[1].content[0].text, /Seoul/);
  await set(null);
  assert.equal(render(), undefined);
  for (const event of ['agent_settled', 'session_start', 'session_shutdown']) {
    await set({ city: 'Paris' });
    handlers.get(event)!();
    assert.equal(render(), undefined);
  }
  await assert.rejects(command!.handler('{}', { isIdle: () => false }), /during a run/);
});
