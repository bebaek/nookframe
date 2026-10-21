// Keep discovery disabled: deployments explicitly opt in to trusted extensions.
export function piExtensionArgs(value: string | undefined): string[] {
  const args = ['--no-extensions'];
  if (value === undefined) return args;
  const invalid = () => new Error('NOOKFRAME_PI_EXTENSIONS must be a JSON array of nonempty extension strings (not CLI flags)');
  let entries: unknown;
  try { entries = JSON.parse(value); }
  catch { throw invalid(); }
  if (!Array.isArray(entries)) throw invalid();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim() || entry.startsWith('-') ||
      entry !== entry.trim() || /[\x00-\x1f\x7f]/.test(entry)) throw invalid();
    args.push('--extension', entry);
  }
  return args;
}
