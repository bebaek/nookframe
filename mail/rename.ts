import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { MailError, MailStore, alias } from './store.js';
import { renderMbsync } from './config.js';

// Retired aliases remain reserved: old drafts, plans and OAuth callbacks must
// never silently bind to a different account (or become approved again).
export async function renameAccount(store: MailStore, from: string, to: string, validate: () => void = () => { store.account(from); }, gmail = true, controlPlaneLocked = false) {
  alias(from); alias(to);
  if (from === to) throw new MailError('ACCOUNT_ALIAS_UNCHANGED');
  const perform = () => store.withAccountSyncLock(from, () => store.withAccountSyncLock(to, () =>
    store.withAccountCredentialLock(from, () => store.withAccountCredentialLock(to, async () => {
      validate();
      const source = store.path('accounts', from + '.json'), destination = store.path('accounts', to + '.json');
      const original = readFileSync(source, 'utf8'), account = JSON.parse(original);
      if (account.polling) throw new MailError('PAUSE_MAIL_JOBS_FIRST');
      const paths = [['maildir', from], ['index', from], ['state', from], ['state', from + '.json']];
      const moves = paths.map(([dir, name]) => [store.path(dir, name), store.path(dir, name === from ? to : to + '.json')]);
      if (existsSync(destination) || store.google?.account(to) || moves.some(([, target]) => existsSync(target))) throw new MailError('ACCOUNT_ALIAS_IN_USE');
      const moved: string[][] = [];
      const configs = ['mbsyncrc', 'notmuch-config'].map(file => store.path('state', from, file))
        .filter(file => existsSync(file)).map(file => [file, readFileSync(file, 'utf8')]);
      const recoveryDir = store.path('.rename-recovery');
      mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
      const recovery = store.path('.rename-recovery', from + '.json');
      if (existsSync(recovery)) throw new MailError('ACCOUNT_RENAME_RECOVERY_REQUIRED');
      store.write(recovery, { from, to, account });
      // Publish a fail-closed tombstone before moving anything. A process crash
      // leaves the alias disabled, never usable against partially moved state.
      store.write(source, { alias: from, renamedTo: to });
      try {
        for (const [oldPath, newPath] of moves) if (existsSync(oldPath)) { renameSync(oldPath, newPath); moved.push([oldPath, newPath]); }
        const renamed = { ...account, alias: to, ...(store.google ? { googleAccount: account.googleAccount ?? from } : {}) };
        if (gmail) for (const [file, text] of configs) {
          const name = file.endsWith('/mbsyncrc') ? 'mbsyncrc' : 'notmuch-config';
          store.writeText(store.path('state', to, name), name === 'mbsyncrc' ? renderMbsync(store.root, renamed)
            : text.replaceAll(store.path('index', from), store.path('index', to)).replaceAll(store.path('maildir', from), store.path('maildir', to)));
        }
        store.write(destination, renamed);
      } catch (error) {
        for (const [oldPath, newPath] of moved.reverse()) renameSync(newPath, oldPath);
        for (const [file, text] of configs) store.writeText(file, text);
        store.writeText(source, original);
        if (existsSync(destination)) unlinkSync(destination);
        unlinkSync(recovery);
        throw error;
      }
      unlinkSync(recovery);
      return { renamed: true, previousAlias: from, account: to, note: 'Old alias is reserved. Unsubmitted drafts/plans need recreation and fresh approval under the new alias. Existing attempt records are unchanged; never automatically retry an attempted send or plan.' };
    })) ));
  return controlPlaneLocked ? perform() : store.locked('oauth', perform);
}
