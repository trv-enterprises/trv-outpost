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

These run automatically as part of the release gate — `make release`
calls `make security-scan` (after the test suite, before tagging).
**Gate policy:**

- **gitleaks** (committed secrets) — **blocks** the release on any leak.
- **npm audit** — **blocks** on `critical` only; `high`/`moderate`/`low`
  are reported but don't block (review + remediate on your own cadence).
- **govulncheck** — **reports only**, never blocks. Output is reconciled
  against the accepted-vulnerability registry (below) so consciously
  accepted findings don't clutter the actionable list. Only
  **symbol-reachable** findings are shown as actionable.

Run `make security-scan` directly any time. A missing tool fails the
gate unless `SECURITY_SCAN_ALLOW_MISSING=1`.

`govulncheck` reports vulnerabilities in three reachability tiers:

1. **Symbol-level reachable** — your code calls into the vulnerable
   function. Treat as actionable.
2. **Imported but not called** — vulnerability is in a package you
   import but no code path reaches it. Track but don't block on.
3. **In a transitive module** — an indirect dependency carries the
   vuln. Lowest priority.

## Accepted-vulnerability registry

Vulnerabilities we have **consciously accepted** — because their blast
radius does not affect this system, or remediation is gated on an
upstream/toolchain bump we don't yet have — live in a structured,
code-reviewed registry:

> **[`security/accepted-vulns.yaml`](security/accepted-vulns.yaml)**

Each entry records the advisory ID, scanner, affected module, who
accepted it, when, an **expiry date** (exceptions are never permanent —
they force periodic re-review), and the justification (why the blast
radius doesn't reach us). The release scan reconciles scanner output
against this file (`security/reconcile-scan.py`):

- a finding listed in the registry (and not expired) → reported as
  **Known-accepted**, kept out of the actionable list;
- any finding **not** in the registry → reported as **ACTIONABLE**;
- an **expired** exception → flagged loudly and treated as actionable
  again (re-affirm or remediate).

**Accepting a vulnerability is an explicit risk decision** — add an
entry to the registry with a justification you'd defend in an audit,
not by silencing the scanner. To remediate instead, bump the Go
toolchain / dependency and the finding disappears on the next scan.

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
