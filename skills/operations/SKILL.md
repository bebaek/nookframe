---
name: operations
description: Inspect this running Nookframe instance, explain its default model configuration, and list its loaded agents through the authenticated operations API.
---

# Nookframe self-inspection

Use `nookctl status`, `nookctl config`, and `nookctl sessions` to answer questions about this instance. Commands return JSON and use the existing `ACCESS_TOKEN_FILE` internally. Never read or print that file yourself, include its contents in commands, or ask the user to paste credentials.

- `status`: current slot, process uptime, and explicitly supported capabilities. This is not an end-to-end health check.
- `config`: current default model configuration and its precedence. This does not describe every running conversation. A null selection means Pi chooses the model; do not invent an exact model.
- `sessions`: loaded agents on this instance, their model, availability, busy state, viewer counts, and lock ownership. This is not an inventory of agents running on other slots or all saved threads. It does not open agents or expose conversation contents.

The interface is read-only. Model changes, job control, diagnostics/log access, and deployments are not supported by these commands. Do not substitute ad hoc file edits for unsupported operations. Report authentication or inspection failures without claiming the system is healthy.

By default the CLI uses loopback and `PORT` (default 3000). `NOOKFRAME_API_URL` explicitly selects another server; remote URLs must use HTTPS. Identify the returned slot before making claims about a particular instance.
