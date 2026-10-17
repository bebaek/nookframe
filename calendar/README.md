# calendarctl

Implemented: private Google OAuth configuration, account connection, local status,
refresh-token handling, calendar discovery/selection, a live read-only agenda, and
chat skill. Background sync, cache, and UI are not implemented.
See [the design](../docs/calendar-mvp.md) for later phases.

## Read-only calendar access

```sh
calendarctl calendars list personal
calendarctl calendars select personal 'CALENDAR_ID' 'ANOTHER_CALENDAR_ID'
calendarctl agenda personal --days 7
calendarctl calendars clear personal
```

List returns accessible calendars, IDs, access roles, and selection flags. Select
replaces the local selection after checking read access; it fetches calendar
metadata but not events and never changes Google's settings. No calendar is
selected automatically. Free/busy-only sources cannot be selected for details.
Clear removes the selection. Choices persist privately under `selections/` in
CALENDAR_DIR, separately from account credentials and reconnect operations.

Agenda fetches selected calendars live for a rolling window starting now (default
7 days, allowed 1–31). Recurring events are expanded by Google, cancelled events
excluded, and results paginated. Overlapping events may start before the window.
All-day dates remain date-only with exclusive end dates; timed events retain their
RFC3339 offsets and provider time-zone fields. Combined results are sorted by
start instant, using date order for all-day entries. Render all-day entries as
calendar dates, not UTC appointments. No implicit user time zone is assumed.

Commands return JSON with provider text marked untrusted. They never execute or
follow event text/links. A failure on any selected calendar fails the entire
agenda instead of returning an apparently complete partial result. Requests time
out after 30 seconds, redirects are refused, and pagination has explicit limits
(200 pages per resource, 50,000 events total); limit failures are not empty results.
No API retries, event writes, cached results, or background jobs are hidden behind
these commands. Calendar names/titles/locations in output may contain private
information: do not publish real output or operational logs.

## Authorization

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

For a single Google setup and token shared with Mail, enable
[shared Google connections](../google/README.md). Existing mail installations
must explicitly migrate before enabling `GOOGLE_DIR`; then skip the second client
configuration step and connect Calendar using the existing mail account alias.

Scopes: `calendar.calendarlist.readonly`, `calendar.events.readonly` (under
`https://www.googleapis.com/auth/`), `openid`, and `email`. Mail authorization is
not reused in standalone mode. Shared mode requests incremental consent instead.
The same Google client may be configured explicitly, but Google grant
revocation can affect both capabilities when they share that client. Testing-mode
refresh tokens may expire; Workspace policy may block authorization.

State is separate under `CALENDAR_DIR`, defaulting to a sibling `calendar` directory
of `STATE_DIR` (`.local/calendar` normally; `/data/calendar` in the container).
In shared mode, credentials live in `GOOGLE_DIR`, not calendar account metadata.
Directories are created 0700 and files 0600. Tokens are plaintext private files,
not isolated from the shared agent/shell. Do not point this at mail storage.
Include this directory in backups before rollout; no deployment or backup changes
are performed by these source changes.

Status is local only and does not prove API readiness or current authorization.
Connecting never fetches events or enables jobs. Only an explicit agenda request
fetches events from selected calendars. Reconfiguring invalidates pending
consent; changing client IDs requires reconnecting accounts. To change the callback,
register the new URI, then configure again privately. Existing account identities
cannot be reassigned to a different Google subject.

The callback uses single-use state and PKCE, not the browser login cookie. Keep
callback query strings out of proxy access logs. Results expose only sanitized
status codes. No credentials are returned through account status.
