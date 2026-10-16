# calendarctl foundation

Implemented: private Google OAuth configuration, account connection, local status,
and refresh-token handling. Calendar discovery, fetching, agenda, skills, and UI
are **not implemented yet**. See [the design](../docs/calendar-mvp.md).

Local commands use `npm run calendar -- ...`; the container installs `calendarctl`.

1. Enable Google Calendar API in your Google Cloud project. Configure consent/test
   users for your intended accounts and create a Web application OAuth client.
2. Run `calendarctl doctor` and register its exact callback URI with Google:
   `PUBLIC_ORIGIN/calendar/oauth/callback`. The Nookframe server handles the return.
3. Run `calendarctl oauth configure` privately in Terminal. Hidden prompts collect
   the client ID and secret; never paste them in chat or pass them as arguments.
4. Run `calendarctl account connect personal`, open the authorization link, and
   deliberately choose the intended account. Never paste callback URLs/codes in chat.
5. Run `calendarctl account status personal`. Repeat for another alias/account.

Scopes: `calendar.calendarlist.readonly`, `calendar.events.readonly` (under
`https://www.googleapis.com/auth/`), `openid`, and `email`. Mail authorization is
not reused. The same Google client may be configured explicitly, but Google grant
revocation can affect both capabilities when they share that client. Testing-mode
refresh tokens may expire; Workspace policy may block authorization.

State is separate under `CALENDAR_DIR`, defaulting to a sibling `calendar` directory
of `STATE_DIR` (`.local/calendar` normally; `/data/calendar` in the container).
Directories are created 0700 and files 0600. Tokens are plaintext private files,
not isolated from the shared agent/shell. Do not point this at mail storage.
Include this directory in backups before rollout; no deployment or backup changes
are performed by these source changes.

Status is local only and does not prove API readiness or current authorization.
Connecting never fetches events or enables jobs. Reconfiguring invalidates pending
consent; changing client IDs requires reconnecting accounts. To change the callback,
register the new URI, then configure again privately. Existing account identities
cannot be reassigned to a different Google subject.

The callback uses single-use state and PKCE, not the browser login cookie. Keep
callback query strings out of proxy access logs. Results expose only sanitized
status codes. No credentials are returned through account status.
