import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piExtensionArgs } from '../server/pi-extensions.js';

test('extension discovery remains disabled by default and with an empty list', () => {
  assert.deepEqual(piExtensionArgs(undefined), ['--no-extensions']);
  assert.deepEqual(piExtensionArgs('[]'), ['--no-extensions']);
});

test('explicit extensions are passed as separate arguments in configured order', () => {
  assert.deepEqual(piExtensionArgs(JSON.stringify(['builtin:mcp', '/opt/pi tools/custom.ts', './local.ts'])), [
    '--no-extensions', '--extension', 'builtin:mcp',
    '--extension', '/opt/pi tools/custom.ts', '--extension', './local.ts',
  ]);
});

test('invalid extension configuration fails without echoing its contents', () => {
  const invalid = ['', ' ', 'secret-invalid-json', 'null', '{}', 'true', '42', '"builtin:mcp"',
    '[null]', '[false]', '[1]', '[{}]', '[[]]', '[""]', '[" "]', '[" builtin:mcp"]',
    '["builtin:mcp "]', '["--approve"]', '["-e"]', '["builtin:mcp", null]',
    JSON.stringify(['bad\npath']), JSON.stringify(['bad\u0000path'])];
  for (const value of invalid) {
    assert.throws(() => piExtensionArgs(value), {
      message: 'NOOKFRAME_PI_EXTENSIONS must be a JSON array of nonempty extension strings (not CLI flags)',
    });
  }
});
