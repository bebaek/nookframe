export const defaultPromptExamples = ['Create a hello.txt file in the workspace.'];

// Operator-authored display text only; never discovers skills or executes prompts.
export function parsePromptExamples(value: string | undefined): string[] {
  if (value === undefined) return [...defaultPromptExamples];
  const invalid = () => new Error('NOOKFRAME_PROMPT_EXAMPLES must be a JSON array of at most 8 non-empty strings (at most 500 characters each)');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!Array.isArray(parsed) || parsed.length > 8 || parsed.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 500)) throw invalid();
  return parsed.map(item => item.trim());
}
