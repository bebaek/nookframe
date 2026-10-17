# Calendar MVP design

Status: CLI/storage/OAuth, on-demand calendar discovery/selection, live read-only
agenda, and chat skill are implemented. See [calendarctl setup](../calendar/README.md)
for the current commands. The cache-only agenda, explicit sync, background jobs,
and UI below remain a future design, not the current interface. The first read
phase deliberately uses `calendarctl agenda ALIAS --days 7` to fetch live data;
it does not silently introduce cached coverage or background work.

## Goal and boundary

First milestone: **show the next seven days across two Google accounts**, with
calendar selection, source labels, correct dates, and honest freshness reporting.
Calendar is an independent capability, usable through `calendarctl`, chat, and
later a standalone Calendar tab. Chat remains capability-neutral. Email links,
invitations, RSVP, and event creation will be integrations, not prerequisites.

Non-goals: remote writes, background polling, push notifications, Outlook, CalDAV,
ICS subscriptions, month/week grids, conflict detection, and a generic integration
framework. Existing mail credentials move only through the explicit shared Google
migration described below; calendar data remains independent.

## Findings in the current code

- `mail/oauth.ts` already implements state + PKCE, single-use 15-minute pending
  authorizations, verified Google identity, alias binding, token refresh, bounded
  requests, and sanitized errors. It hardcodes the Gmail scope and callback.
- `mail/store.ts` provides private directories, atomic JSON replacement, and
  cross-process locks. Its account schema and configuration locking are coupled
  to Gmail, mail polling, and sync. It is not a generic account store.
- `mail/cli.ts` provides private TTY OAuth configuration and JSON commands;
  `mail/runtime.ts` constructs the CLI runtime independently of the web server.
- `server/http.ts` handles OAuth callbacks without a browser cookie because
  cross-site redirects omit SameSite=Strict cookies. State + PKCE authorize the
  exchange; the browser is redirected to a clean, allowlisted result page.
  There is currently no calendar or mail data REST API.
- `server/main.ts` wires the mail runtime, environment, and skill explicitly.
  Calendar needs equivalent wiring, not mail operations added to chat protocol.

**Share Google connections, not capability data.** Calendar does not inherit
`MailStore` or call `MailOAuth.accessToken()`. Optional `GOOGLE_DIR` stores the
shared Google client, credentials, scopes, and locks. Capability-specific OAuth
flows and data stores remain separate. See [shared Google setup](../google/README.md)
for explicit migration and operational boundaries.

## Authorization

Use Google's Calendar API with `calendar.calendarlist.readonly` and
`calendar.events.readonly` scopes (full URLs under
`https://www.googleapis.com/auth/`), plus `openid email`. Verify granted scopes;
missing consent must fail clearly. Enable Calendar API in the chosen project.

Register `/calendar/oauth/callback` explicitly alongside the mail callback. In
shared mode, configure one Google web client and use one credential set per
account. Calendar keeps its own pending authorizations and callback. Consent uses
incremental authorization, requests the new capability scopes, and preserves
recorded grants. Calendar-only accounts do not request mail access. Record actual
granted scopes and Google subject identity; bind aliases to that identity on
reconnect. Revoking the Google application can affect both capabilities. Do not
add provider-wide revocation in this MVP. Standalone mode remains available when
`GOOGLE_DIR` is unset; existing mail migration requires explicit offline action.

Retain mail's protections: hidden TTY input, PKCE, single-use state, expiration,
client binding, account credential locks, refresh-token rotation, no secrets in
JSON output or logs, and callback URL redaction in deployment access logs.
Calendar connection and selection do not start a fetch automatically.

## Proposed CLI contract

The OAuth and account commands are implemented; calendar discovery, selection,
sync, and agenda below describe the future interface:

```sh
calendarctl doctor
calendarctl oauth configure                 # private TTY only
calendarctl account connect personal
calendarctl account status [personal]
calendarctl calendars personal --refresh    # discover calendars from Google
calendarctl calendars personal              # cached list
calendarctl calendar select personal CALENDAR_ID
calendarctl calendar unselect personal CALENDAR_ID
calendarctl sync [personal] --from 2026-10-12 --to 2026-10-19 --timezone Asia/Seoul
calendarctl sync status [personal]
calendarctl agenda --from 2026-10-12 --to 2026-10-19 --timezone Asia/Seoul
```

Calendar selection is local and explicit; start with none selected. Discovery
returns source IDs, names, time zones, access roles, and selection flags. Treat
provider IDs as opaque strings, never paths. Refresh discovery with pagination;
retain selection only for calendars still accessible, and report lost access.

Agenda is cache-only. Sync explicitly fetches a bounded window for selected
calendars; default window is today through seven local dates later in an explicit
IANA time zone. Accept date bounds with an exclusive end and cap windows at 31
days initially. Reject invalid dates/zones and reversed or oversized ranges.

Return versioned JSON with `untrusted: true` for provider content, requested
window, display zone, events, per-source coverage/freshness, and `complete`.
Distinguish no accounts, no selection, missing coverage, partial failure, and a
successfully fetched empty agenda. Nonzero exit on incomplete coverage or failed
refresh, while preserving usable results in JSON. A successful old snapshot may
cover the window but is not evidence of current availability: always expose its
fetch time and any subsequent failure.

## Data and persistence

Proposed `CALENDAR_DIR`: `.local/calendar` locally, `/data/calendar` in the
container. CLI and server must resolve the same configured root. Add it to
backup/restore configuration before rollout; existing mail backups must not be
assumed to include it.

Use private directories (0700), atomic files (0600), schema versions, validated
reads, and separate credential and sync locks. No network I/O while holding a
credential lock except token refresh. Document a consistent lock order.

Persist:

- Private pending state and account metadata; Google client and credentials live
  in `GOOGLE_DIR` in shared mode (locally in standalone mode).
- Account identity, discovered calendars, and selected source IDs.
- A bounded, replaceable snapshot per selected calendar with its exact fetched
  window, events, fetch time, and latest attempt status. A new window replaces
  the previous snapshot; requests outside coverage report missing coverage.

Normalized event fields: account, calendar ID, provider event ID, title,
optional location, status, visibility, self response status, and recurrence
provenance (`recurringEventId`, `originalStartTime`). Use a discriminated time
shape: timed events preserve RFC3339 instants and available IANA zones; all-day
events preserve date-only start and exclusive end. Do not convert all-day dates
into UTC midnight. Omit descriptions, attachments, and attendee lists initially.
Missing/private titles display as “Busy” without inventing details.

Identity is scoped to account + calendar + event ID. Never collapse events from
different accounts by title, time, or iCalUID: those copies can have different
permissions and RSVP state.

## Fetch and agenda semantics

Use Google `events.list` with bounded `timeMin`/`timeMax`, `singleEvents=true`,
and pagination; let Google expand recurring instances. Cover events overlapping
the interval, including events beginning before it. Convert local-date boundaries
using the requested IANA zone, not fixed 24-hour arithmetic (DST matters).

Request no deleted events for these full snapshots. A successful complete fetch
replaces the prior snapshot, removing canceled/deleted instances and honoring
moved exceptions. Do not merge snapshots indefinitely or implement incremental
sync tokens yet.

Publish a calendar snapshot only after all pages succeed. Bound request duration,
response size, pages, and event counts; reaching a cap is incomplete, not a
successful truncated agenda. A failure retains the previous snapshot with a
visible error. Account/calendar failures must not hide successful sources.
Honor rate-limit retry hints with bounded retries; invalid grants require
reconnection. No automatic infinite retries or scheduler in this slice.

Calendar content is untrusted data. Render plain text, never provider HTML;
do not fetch links or remote assets. Chat must not follow instructions embedded
in event titles or interpret an incomplete agenda as “you are free.”

## Delivery sequence and acceptance

1. **CLI foundation + OAuth:** `calendar/` runtime, store, OAuth, CLI entry point,
   callback wiring, build/container packaging, and fake-provider tests. Test state
   replay/expiry, wrong identity, missing scopes, concurrent refresh, and secret
   redaction. Existing mail behavior and tests must remain intact.
2. **Discovery + agenda:** selection, bounded snapshot sync, cache-only agenda,
   and per-source status. Test pagination failure, rate limits, empty calendars,
   lost access, stale/missing coverage, repeated sync, cancellation, moved recurring
   instances, multi-day/all-day overlap, midnight boundaries, and DST transitions.
3. **Chat access:** add `skills/calendar/SKILL.md` and explicit host wiring. Teach
   discovery/selection, refreshing only when requested, source attribution, and
   freshness limitations. No calendar-specific chat widgets.
4. **Standalone UI:** Calendar tab with agenda and source picker, backed by the
   same service functions (not shell command construction). Add authenticated
   HTTP endpoints; protect refresh/selection mutations with exact Origin checks.
   Calendar must work without an active chat or available model. Start with agenda,
   not a calendar grid.

Before real-account acceptance, run `npm run check`, `npm test`, and
`npm run build`, plus relevant container/browser smoke tests for added wiring.
Use fake providers in automated tests; no live account changes in tests.

Live acceptance, with explicit user consent: connect two accounts, select at least
one calendar each, fetch seven days, and compare dates and instances with Google
Calendar. Demonstrate one failed source alongside a working source without
claiming the aggregate is complete. Verify restart persistence and backup coverage.

The next implementation slice is **step 2**, not a shared-accounts refactor or UI.
Live OAuth acceptance and container rollout remain pending user authorization.

## Provider references to verify during implementation

- https://developers.google.com/workspace/calendar/api/auth
- https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
- https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- https://developers.google.com/workspace/calendar/api/v3/reference/events
- https://developers.google.com/identity/protocols/oauth2/web-server
