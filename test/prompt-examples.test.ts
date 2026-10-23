import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromptExamples, parsePromptExamples } from '../server/prompt-examples.js';

test('prompt examples: defaults, override, disable and plain text', () => {
  assert.deepEqual(parsePromptExamples(undefined), defaultPromptExamples);
  assert.deepEqual(parsePromptExamples('[]'), []);
  assert.deepEqual(parsePromptExamples('[" Summarize unread mail ", "<b>Calendar</b>"]'), ['Summarize unread mail', '<b>Calendar</b>']);
});

test('prompt examples: reject invalid configuration without echoing input', () => {
  for (const value of ['', 'secret', '{}', 'null', '[1]', '[null]', '[""]', '["  "]', JSON.stringify(['x'.repeat(501)]), JSON.stringify(Array(9).fill('example'))]) {
    assert.throws(() => parsePromptExamples(value), { message: 'NOOKFRAME_PROMPT_EXAMPLES must be a JSON array of at most 8 non-empty strings (at most 500 characters each)' });
  }
});
