// Only finite, explicitly approved fields cross the subprocess privacy boundary.
// Never persist/return raw stderr, stdout, exception messages, or command arguments.
const messages = {
  timeout: 'The configured subprocess deadline was reached.',
  quota: 'Provider reported a quota or bandwidth limit. Pause retries; reset time is unknown.',
  authentication: 'Authentication failed or authorization needs renewal.',
  busy: 'The credential lock remained busy after the bounded wait. Retry later.',
  tls: 'TLS or certificate validation failed.',
  network: 'The connection failed or timed out before the subprocess deadline.',
  storage: 'Local storage is full, read-only, or inaccessible.',
  output_limit: 'Subprocess output exceeded the private capture limit.',
  spawn_failed: 'The subprocess could not be started.',
  signal: 'The subprocess was terminated by a signal.',
  unknown: 'The subprocess failed; no safe diagnostic pattern was recognized.',
} as const;
export type Category = keyof typeof messages;
export interface Diagnostic {
  category: Category; message: string; elapsedMs: number; timeoutMs: number;
  exitCode?: number; signal?: string; responseCode?: string; providerMessage?: string;
}
const codes = ['OVERQUOTA', 'LIMIT', 'AUTHENTICATIONFAILED', 'UNAVAILABLE', 'ALERT'];
const providerMessages = ['Account exceeded command or bandwidth limits', 'Too many simultaneous connections', 'Invalid credentials'];
const signals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV'];
export function classifyFailure(error: { code?: unknown; signal?: unknown }, text: string, timedOut: boolean, elapsedMs: number, timeoutMs: number): Diagnostic {
  const responseCode = codes.find(code => text.includes(`[${code}]`));
  const providerMessage = providerMessages.find(message => text.toLowerCase().includes(message.toLowerCase()));
  const category: Category = timedOut ? 'timeout'
    : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit'
    : responseCode === 'OVERQUOTA' || responseCode === 'LIMIT' || /Account exceeded command or bandwidth limits|Too many simultaneous connections|rate limit exceeded/i.test(text) ? 'quota'
    : /MAIL_TOKEN_ERROR:MAIL_BUSY\b/.test(text) ? 'busy'
    : /MAIL_TOKEN_ERROR:RECONNECT_ACCOUNT|AUTHENTICATIONFAILED|invalid credentials|authentication failed/i.test(text) ? 'authentication'
    : /certificate verification|certificate verify|TLS error|SSL error/i.test(text) ? 'tls'
    : /no space left on device|permission denied|read-only file system/i.test(text) ? 'storage'
    : /connection reset|connection refused|connection closed|unexpected EOF|socket error|socket timeout|timed out/i.test(text) ? 'network'
    : error.code === 'ENOENT' || error.code === 'EACCES' ? 'spawn_failed'
    : typeof error.signal === 'string' ? 'signal' : 'unknown';
  return sanitizeDiagnostic({ category, elapsedMs, timeoutMs, exitCode: error.code, signal: error.signal, responseCode, providerMessage })!;
}
export function sanitizeDiagnostic(value: any): Diagnostic | undefined {
  if (!value || !Object.hasOwn(messages, value.category) || typeof value.category !== 'string') return undefined;
  const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!number(value.elapsedMs) || !number(value.timeoutMs)) return undefined;
  const category = value.category as Category;
  return { category, message: messages[category], elapsedMs: value.elapsedMs, timeoutMs: value.timeoutMs,
    exitCode: number(value.exitCode) && value.exitCode <= 255 ? value.exitCode : undefined,
    signal: signals.includes(value.signal) ? value.signal : undefined,
    responseCode: codes.includes(value.responseCode) ? value.responseCode : undefined,
    providerMessage: providerMessages.includes(value.providerMessage) ? value.providerMessage : undefined };
}
export const diagnosticErrorCode = (category: Category) => category === 'authentication' ? 'RECONNECT_ACCOUNT' : `MAIL_${category.toUpperCase()}`;
export const diagnosticErrorCodes = Object.keys(messages).map(category => diagnosticErrorCode(category as Category));
