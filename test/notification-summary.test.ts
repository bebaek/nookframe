import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationSummary } from '../shared/notification-summary.js';

test('summary uses only the opening paragraph and strips common Markdown', () => {
  assert.equal(notificationSummary('  **Fixed** the [routing](https://example.test/private).\nAll `tests` pass.\n\nDetails here'), 'Fixed the routing. All tests pass.');
  assert.equal(notificationSummary('# Done\r\n\r\nMore'), 'Done');
  assert.equal(notificationSummary('- **Done**'), 'Done');
  for (const text of ['', ' \n ', '![image](/private)', '```ts\nsecret\n```']) assert.equal(notificationSummary(text), '');
});

test('summary caps Unicode characters at 160 including ellipsis', () => {
  assert.equal(notificationSummary('a'.repeat(160)), 'a'.repeat(160));
  assert.equal(notificationSummary('😀'.repeat(170)), '😀'.repeat(159) + '…');
});
