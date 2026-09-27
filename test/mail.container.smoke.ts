import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('offline mail container: TLS/XOAUTH2, pull-only IMAP, isolated indexes and safe reads', { timeout: 60000 }, () => {
  assert.ok(process.env.TEST_IMAGE, 'Set TEST_IMAGE to a built image');
  const output = execFileSync('podman', ['run', '--rm', '-i', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--tmpfs', '/tmp:rw,mode=1777', '--entrypoint', 'python3', process.env.TEST_IMAGE, '-'], {
    input: readFileSync('test/mail/imap-smoke.py'), encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024,
  });
  assert.match(output, /Offline mail smoke passed/);
});
