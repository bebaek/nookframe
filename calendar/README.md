# calendarctl

Implemented: private Google OAuth configuration, account connection, local status,
refresh-token handling, calendar discovery/selection, a live read-only agenda, and
chat skill. Opt-in, confirmed single-event CRUD is also available on owned
calendars without attendees. Background sync, cache, and UI are not implemented.
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

## Opt-in single-event writes

Normal account connection stays read-only. Request additional
`calendar.events.owned` consent explicitly, then separately enable each owned
calendar for writes (read selection does not enable writes):

```sh
calendarctl account connect personal --write
calendarctl writes enable personal 'CALENDAR_ID'
calendarctl writes status personal
calendarctl events get personal 'CALENDAR_ID' 'EVENT_ID'
calendarctl events prepare-create personal 'CALENDAR_ID' < event.json
calendarctl events prepare-update personal 'CALENDAR_ID' 'EVENT_ID' < changes.json
calendarctl events prepare-delete personal 'CALENDAR_ID' 'EVENT_ID'
# Review the returned operation, then explicitly confirm that exact preview:
calendarctl events apply OPERATION_ID --confirm CONFIRMATION_HASH
calendarctl events status OPERATION_ID
calendarctl writes disable personal 'CALENDAR_ID'
```

Example create input (synthetic; use the intended calendar's actual time zone):

```json
{"summary":"Appointment","start":{"dateTime":"2026-11-02T09:00:00-06:00","timeZone":"America/Chicago"},"end":{"dateTime":"2026-11-02T10:00:00-06:00","timeZone":"America/Chicago"}}
```

Only summary, description, location, start, and end are accepted. Update uses a
partial object; time changes require a complete valid resulting range. Timed
boundaries require explicit offsets matching the named time zone, including DST.
All-day events use `{"date":"2026-11-02"}` and an exclusive end date. Attendees,
recurrence/instances, foreign organizers, special event types, locked events, and
conference links are excluded from writes. Default calendar reminders can still
apply; writes request `sendUpdates=none`, not a guarantee of zero Google emails.

Preparation does provider reads only and saves a private immutable preview with
a 15-minute expiry. Show the full before/after change and get user confirmation.
Application rechecks write enablement, owner access, account/client binding, and
the event ETag; update/delete additionally send `If-Match` to catch races. Write
scope is checked before and after refresh. Create uses a persisted client-generated
event ID. Local per-account locks serialize submission and configuration changes.

The operation is durably marked submitting before any mutation request. Network,
server, decode, or persistence ambiguity becomes unknown (or remains submitting
if storage fails). Any attempted operation is blocked from resubmission, including
after restart. Status and read commands support investigation; there is no
automatic retry/reset/reconciliation that could create duplicates. Do not prepare
a replacement operation until an uncertain outcome has been resolved deliberately.
A rejected request requires fresh review and confirmation, not automatic retries.

Local `writes/` and `operations/` files are private (0600), covered by backups of
CALENDAR_DIR, and contain event details. Never publish them. Confirmation hashes
bind previews but are not an independent authorization boundary against an agent
or shell already able to edit local files or read provider credentials.

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
Connecting never fetches events or enables jobs or calendar writes. Agenda,
event-detail reads, and update/delete preparation explicitly fetch event data. Reconfiguring invalidates pending
consent; changing client IDs requires reconnecting accounts. To change the callback,
register the new URI, then configure again privately. Existing account identities
cannot be reassigned to a different Google subject.

The callback uses single-use state and PKCE, not the browser login cookie. Keep
callback query strings out of proxy access logs. Results expose only sanitized
status codes. No credentials are returned through account status.
