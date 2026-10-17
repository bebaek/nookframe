# Shared Google connections

Mail and Calendar can share one Google OAuth client configuration and one
credential set per account. Capability data remains in `MAIL_DIR` / `CALENDAR_DIR`;
credentials and cross-process OAuth/refresh locks live in **`GOOGLE_DIR`**.

Sharing is explicitly enabled by setting `GOOGLE_DIR` to the same absolute path
for the server and all CLI workers. Without it, existing separate stores continue
to work unchanged. The server propagates the resolved path to its agent, terminal,
and mail scheduler. The container does not enable migration automatically.

## New installations

1. Set `GOOGLE_DIR` (for example `/data/google` in the container) and include it in
   private backups. Locally, use an absolute path such as `$PWD/.local/google`.
2. In Google Cloud, register **both** exact redirect URIs:
   `PUBLIC_ORIGIN/mail/oauth/callback` and
   `PUBLIC_ORIGIN/calendar/oauth/callback`. Enable APIs for the capabilities used.
3. Configure the Google web client once, privately, with either
   `mailctl oauth configure` or `calendarctl oauth configure`.
4. Connect accounts through the capability you want. Use the **same alias** when
   enabling the other capability for that Google account.

A calendar-only connection requests calendar read scopes, not Gmail permissions.
Adding mail requests the Gmail scope with incremental consent. Adding Calendar to
mail requests its read scopes and preserves previously recorded granted scopes.
Tokens and actual granted scopes are shared; access checks remain capability-specific.
Connection status is local metadata, not proof that Google still accepts a token.

A second capability still needs explicit `account connect ALIAS` consent. No jobs,
event fetching, or mail sync are enabled by connecting. Calendar remains OAuth-only
at this stage. Accounts cannot silently change identity or use multiple aliases for
the same Google identity. Migrated mail identities are initially verified-email
bound; the next successful consent also records Google's stable subject ID.

## Existing mail installations: explicit migration

Do not enable shared mode on a running legacy deployment without migrating first.
Do not run old binaries against migrated files.

1. Pause mail jobs, allow active operations to finish, and stop the Nookframe host
   and standalone CLI workers. Preserve a private backup of mail/configuration.
2. Set `MAIL_DIR` to the existing mail directory and `GOOGLE_DIR` to the new private,
   persistent directory. Do not point these at the same directory. Arrange backup
   coverage for `GOOGLE_DIR` before rollout.
3. Using the new code while the host is stopped, run:

   ```sh
   googlectl migrate-mail --confirm
   # From a source checkout: npm run google -- migrate-mail --confirm
   ```

4. Keep `GOOGLE_DIR` configured for the restarted host and every standalone worker.
   Verify mail account status and doctor, then perform an explicitly requested
   read-only mail operation before resuming jobs.
5. Register the Calendar callback, then run `calendarctl account connect ALIAS`
   using the existing mail alias. No second client-secret entry is necessary.

Migration makes **no provider requests**. It imports existing credentials and the
known Gmail scope, strips tokens from mail account metadata, removes the old client
configuration after successful import, and leaves polling settings, Maildir,
indexes, drafts, and sending outcomes in place. Enabled jobs and held locks block
migration. A conflicting shared client or duplicate identity fails closed.

Re-running after an interruption uses existing shared credentials rather than
restoring stale tokens; account metadata is updated atomically per file. This is
not a multi-file transaction: retain the backup, and do not restart old binaries
mid-migration. Restore the complete pre-migration backup to roll back, accounting
for any subsequent token rotation before reconnecting. Never print backup secrets.

Already-connected standalone Calendar credentials are not automatically imported
or merged with mail credentials: OAuth grants cannot be combined offline. After
mail migration, reconnect Calendar under the same alias in shared mode. The new
consent replaces its legacy token-bearing metadata with a shared reference.

## Boundaries and failure behavior

- Tokens are private plaintext files, not isolated from the shared agent/shell.
- Google application revocation, invalid grants, and client changes can affect
  both capabilities. Reconnect explicitly; no automatic consent or provider writes.
- Both modules use the same per-account refresh lock and re-read shared credentials
  after acquiring it, preventing competing refresh-token rotation.
- Shared client configuration takes the OAuth control lock and all shared account
  credential locks. Refresh only takes its account lock. Migration additionally
  holds legacy control, sync, and credential locks before shared locks.
- Authorization uses single-use state and PKCE. Pending flows and callback paths
  remain capability-specific. Keep callback query strings out of access logs.
- Only scopes actually returned by Google are persisted on consent. A scope loss
  disables affected API access rather than fabricating authorization.
- No live accounts or deployment configuration are changed by this implementation.
