# Security

## Reporting a vulnerability

Please email **tom.r.viviano@gmail.com** with a description of the
issue and steps to reproduce. Avoid opening a public GitHub issue
for unpatched security findings.

## Vulnerability scanning

The codebase is scanned with three tools:

| Tool | Scope | How to run |
|---|---|---|
| `npm audit` | `client/` JS dependencies (vulnerable npm packages) | `cd client && npm audit` |
| `govulncheck` | `server-go/` Go module + reachable-symbol vulns in stdlib + imports | `cd server-go && govulncheck ./...` |
| `gitleaks` | Repo tree + full git history (committed secrets) | `gitleaks detect --no-banner` |

Run the full set before tagging a release. They take a few minutes
combined and have caught real issues — see
[Last full scan](#last-full-scan) below.

`govulncheck` reports vulnerabilities in three reachability tiers:

1. **Symbol-level reachable** — your code calls into the vulnerable
   function. Treat as actionable.
2. **Imported but not called** — vulnerability is in a package you
   import but no code path reaches it. Track but don't block on.
3. **In a transitive module** — an indirect dependency carries the
   vuln. Lowest priority.

## Last full scan

**Date:** 2026-05-03
**Result:** 0 reachable vulnerabilities across npm, Go, and secrets.

### Acknowledged unreachable findings

`govulncheck` flags 3 lower-tier vulnerabilities that we have
reviewed and accepted as not exploitable in this codebase. They
will continue to appear on each scan until upstream patches reach
our dependency graph; that's expected.

| Advisory | Module | Why unreachable here |
|---|---|---|
| [GO-2026-4503](https://pkg.go.dev/vuln/GO-2026-4503) | `filippo.io/edwards25519@v1.1.0` | Indirect transitive dep. The vulnerable code path is not reached by any caller in our dependency graph. Fixed in `v1.1.1`; will resolve when an ancestor releases a bumped pin. |
| [GO-2025-4135](https://pkg.go.dev/vuln/GO-2025-4135) | `golang.org/x/crypto/ssh/agent` | We do not use the `ssh/agent` package. The MongoDB driver pulls in `golang.org/x/crypto` for other primitives. |
| [GO-2025-4134](https://pkg.go.dev/vuln/GO-2025-4134) | `golang.org/x/crypto/ssh` | We do not open SSH connections. Same incidental import as above. |

If you re-run the scan and see additional findings beyond these
three, treat them as new and triage.

## Known security posture

A few intentional design decisions worth knowing about:

- **Browser auth is optional.** Without Clerk env vars, the server
  identifies users by `X-User-ID` (the user's GUID) and trusts the
  reverse proxy / kiosk environment to enforce who can talk to it.
  See [docs/architecture/auth-modes.md](docs/architecture/auth-modes.md)
  for the full model and when to turn each on.
- **Connection secrets are write-only over the API.** Passwords,
  API keys, MQTT credentials, and similar fields can be set or
  replaced via `POST` / `PUT /api/connections`, but `GET` responses
  always return them masked as `"********"`. There is no opt-out
  flag. The update path resolves masked values back to the stored
  real value, so a client that reads-then-writes without touching a
  secret keeps the stored value intact; sending any non-masked value
  overwrites the stored secret. Bundle exports also mask, and the
  importer prompts the user to re-enter the secret on create.
- **Custom code components evaluate user-authored JavaScript at
  runtime in the browser.** The dashboard treats authoring (Design
  mode) as a privileged capability — only users with `design`
  capability can write component code, and viewers cannot mutate
  it. Don't grant `design` to untrusted users.
- **The connection query endpoint enforces a server-side SQL verb
  guard.** `POST /api/connections/:id/query` executes client-supplied
  SQL and is a no-capability endpoint (View Mode renders every
  non-streaming chart through it), so it cannot be defended by
  capability gating. The realistic threat is replay/body-tamper:
  swapping a legitimate request's `raw` for an `INSERT`/`DELETE`/`DROP`.
  A guard in `connection_service.go:QueryConnection` (running for
  **every** caller — View, Design, the AI/MCP `query_connection` tool,
  and raw replays alike) classifies the statement on `sql` + `edgelake`
  connections: `SELECT`/`WITH(→read)` is always allowed; DDL
  (`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/…) is **always refused**;
  `INSERT`/`UPDATE`/`DELETE` are refused unless an admin opts in via the
  `query_guard.allow_insert`/`_update`/`_delete` settings (default off →
  strict read-only); multi-statement bodies are rejected. The guard keys
  off the **connection's** type (server-side), never the client-supplied
  `query.Type` — a deliberate choice that closed a type-confusion bypass
  found in breach testing. It is **defense-in-depth**: the primary defense
  remains **least-privilege (read-only) database credentials** on each
  connection, and the guard does **not** restrict read queries, so a
  viewer can still run arbitrary `SELECT`s (scope those with DB grants).
  Full rationale, threat model, and the rejected designs are in
  [docs/design-notes/query-verb-guard.md](docs/design-notes/query-verb-guard.md).
