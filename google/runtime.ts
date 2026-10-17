import { GoogleStore } from './store.js';
// Explicit opt-in lets existing installations migrate while stopped, rather than
// silently moving credentials during an unrelated mail command.
export function googleStore(): GoogleStore | undefined {
  return process.env.GOOGLE_DIR ? new GoogleStore(process.env.GOOGLE_DIR) : undefined;
}
