// Internal mbsync PassCmd helper. Its stdout is a private credential pipe, not
// an agent tool result. Never invoke this file from chat or with shell tracing.
import { mailRuntime } from './runtime.js';
import { MailError } from './store.js';
try {
  if (process.stdout.isTTY || process.argv.length !== 3) throw new MailError('PRIVATE_PIPE_REQUIRED');
  const { oauth } = mailRuntime();
  process.stdout.write(await oauth.accessToken(process.argv[2]) + '\n');
} catch (error) {
  const code = error instanceof MailError ? error.code : 'TOKEN_REFRESH_FAILED';
  process.stderr.write(`MAIL_TOKEN_ERROR:${code}\n`);
  process.exitCode = 1;
}
