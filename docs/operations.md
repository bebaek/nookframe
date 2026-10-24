# Self-inspection operations

The first operations increment is deliberately read-only. Existing access-token authentication protects `GET /api/operations/{status,config,sessions}`. These routes accept either the existing browser session cookie or `Authorization: Bearer <existing access token>`. No new credential is introduced. Requests with an Origin header must match the existing allowed-origin policy; responses are not cacheable. Other methods return 405. Failures return a generic error rather than exception contents.

In the image:

```
nookctl status
nookctl config
nookctl sessions
```

From a checkout: `npm run ops -- status`. The CLI reads `ACCESS_TOKEN_FILE` internally, defaults to `http://127.0.0.1:${PORT:-3000}`, and accepts an explicit `NOOKFRAME_API_URL` origin. Remote origins require HTTPS; redirects are refused and requests time out after ten seconds. Never put tokens in command arguments.

## Semantics

- **status**: schema version, slot, process uptime and supported capability flags. Not a provider or dependency health probe.
- **config**: re-evaluates instance-default model selection, reporting environment > saved > Pi precedence and whether the environment locks it. No environment dump, configuration paths or credentials. An unspecified Pi model remains null rather than a guessed effective model.
- **sessions**: bounded by the instance's agent capacity; loaded agents only, including runtime model/source, busy/available state, viewer references and lock ownership. No prompts, messages, titles, tool output or history. Not a cross-slot inventory. Reading does not start or acquire an agent.

The operations skill is loaded for interactive agents. Background read-only agents do not gain a new tool or credential through this change. Existing shell access remains a separate trust boundary: this API is not a sandbox against processes already able to read the access-token file.

## Deferred

Model mutations need distinct contracts for active-thread versus instance-default settings, revision checks, and verification. Job inventory/control, redacted diagnostics, build identity, approvals/auditing, and deployment adapters remain future increments. Existing WebSocket model controls are unchanged.
