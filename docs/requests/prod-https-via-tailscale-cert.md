# Request: enable HTTPS on prod dashboard (LXC 100) via Tailscale cert

**For:** homelab-deploy
**Requested:** 2026-08-28
**Type:** mostly a config change to an existing, already-proven mechanism —
but see "HTTP and HTTPS must BOTH keep working", which pre-prod does **not**
currently satisfy and which likely needs a dashboard-image change first
(I'll own that part)

---

## What's being asked

Turn on HTTPS for the production dashboard host (`dashboard`, LXC 100,
`100.97.221.61`) using the **same Caddy + Tailscale-cert mechanism already
running on pre-prod**, so the dashboard is reachable at:

```
https://dashboard.tailac8a95.ts.net
```

This is not new infrastructure. The dashboard Ansible role already supports it,
pre-prod has been running it since 2026-06-10, and the only reason prod doesn't
have it is that the three enabling host_vars were never added to
`inventory/host_vars/dashboard.yml`.

## Why now

A browser will not grant microphone access (`getUserMedia`) outside a **secure
context**. Prod currently serves plain HTTP on port 80 only, so any dashboard
feature needing the mic is blocked at the browser regardless of what the app
does.

The immediate driver is a proposed **doorbell two-way-audio component** (talk to
whoever is at the front door from the dashboard). The Reolink doorbell has been
confirmed capable — ONVIF reports `AudioOutputs: 1`, and Scrypted on the NVR has
already registered the device's `Intercom` interface. But none of that reaches a
browser over `http://`.

Worth noting the driver is *not* the only reason: HTTPS on prod also removes the
`crypto.subtle` secure-context class of error generally, and matches pre-prod.
It's worth doing on its own merits.

**Also note:** switching to the `.ts.net` *hostname* alone does NOT fix this.
`http://dashboard.tailac8a95.ts.net` is still an insecure origin. It's the TLS
that matters; the hostname is required because of the bare-IP limitation below.

## Current state (verified 2026-08-28)

On the prod host:

```
$ sudo ss -tlnp | grep -E ':(80|443|3001) '
LISTEN  0  4096  0.0.0.0:3001   docker-proxy
LISTEN  0  4096  0.0.0.0:80     docker-proxy
# no 443

$ sudo tailscale serve status
No serve config

$ sudo ls /var/lib/tailscale/certs/
no certs dir
```

`inventory/host_vars/dashboard.yml` has no `dashboard_enable_https`,
`dashboard_domain`, or `dashboard_caddy_tls_directive`.

Pre-prod, by contrast, answers cleanly:

```
$ curl -o /dev/null -w '%{http_code} ssl_verify=%{ssl_verify_result}\n' \
    https://dashboard-preprod.tailac8a95.ts.net/
200 ssl_verify=0
```

## Proposed change

Add to `inventory/host_vars/dashboard.yml`, mirroring
`dashboard-preprod.yml` lines 70–78:

```yaml
dashboard_enable_https: true
dashboard_domain: "dashboard.tailac8a95.ts.net"
# See the ts-store push blocker below — must be pinned, not derived.
dashboard_public_tls: false
# Must be MULTI-LINE: the Caddyfile requires the block's `{` to end its line,
# so a one-line `tls { get_certificate tailscale }` fails to parse with
# "Unexpected next token after '{'". The role's template converts these
# newlines to \n for the compose env var.
dashboard_caddy_tls_directive: |-
  tls {
    get_certificate tailscale
  }
```

Then redeploy prod:

```
make deploy-dashboard DASHBOARD_VERSION=0.59.3
```

### Side effect: ts-store ALERT WEBHOOKS are hardcoded `http://<ip>` and will NOT follow

Separate from the push callbacks below, and worse: **existing ts-store alert
rules store an absolute `http://` callback URL that this change does not
update.**

`TSStoreAlertRulesService.CreateAlert` builds the default webhook target as
(`internal/service/tsstore_alert_rules_service.go:1018`):

```go
webhookURL = fmt.Sprintf("http://%s/api/webhooks/tsstore/%s/%s",
    streaming.DashboardHostPort(), conn.ID, secret)
```

Two properties:

1. **The scheme is a literal `http://`** — it cannot become `https://` through
   any config, unlike the push path whose scheme derives from
   `DASHBOARD_PUBLIC_TLS`.
2. **The host is a LAN IP on the backend port.** Prod runs
   `DASHBOARD_HOST=192.168.1.44:3001` (verified in the running container), so
   registered alert webhooks point at `http://192.168.1.44:3001/...` — straight
   to the Go server, **bypassing Caddy entirely**.

Note these are the *same* two knobs the push callback uses, resolved by the
same `streaming.DashboardHostPort()`. The alert webhook is the more honest of
the two: it says `http://` and points at a plaintext port, which is at least
self-consistent. See the blocker above for why the push path's derived scheme
is the one that actually breaks.

**The practical upshot is actually reassuring for this request:** because those
webhooks hit port 3001 directly and never traverse Caddy, the HTTPS change on
port 80/443 does **not** break them. They will keep working exactly as they do
now. So this is *not* a blocker for enabling HTTPS.

**But it does mean:**

- Alert webhooks stay on plaintext HTTP inside the LAN even after the dashboard
  is HTTPS. The callback URL carries the webhook secret, so that secret remains
  on the wire in the clear — the very thing `DASHBOARD_PUBLIC_TLS` exists to
  prevent for push callbacks. Inconsistent, and worth fixing.
- Any *new* alert rules created after the change will still be minted as
  `http://<ip>:3001/...`.
- If `DASHBOARD_HOST` is ever repointed at the `.ts.net` name to fix this,
  **every existing alert rule must be re-registered**, since the URL is stored
  absolute on the ts-store side at creation time.

**Not being requested here** — no action needed from homelab-deploy beyond
pinning `dashboard_public_tls: false` as described in the blocker above. Please
do **not** change `DASHBOARD_HOST` as part of this work: it would break both
existing alert rules (their URLs are stored absolute on the ts-store side) and
push registrations, without fixing the underlying design.

Filed as **dashboard #299** — the scheme and host are decided independently and
neither is tied to a URL that actually terminates TLS. The real fix is to
derive both from the public origin, which is a dashboard-repo change with a
re-registration story attached. Recorded here because it was found while
scoping this request and it explains why `dashboard_public_tls` must be pinned.

### ⚠ BLOCKER: ts-store push callbacks would break — pin `dashboard_public_tls: false`

The role **derives `DASHBOARD_PUBLIC_TLS` from `dashboard_enable_https`**, so
turning HTTPS on would also flip prod's advertised ts-store push callback from
`ws://` to `wss://` (dashboard #260).

**That flip breaks push on this host.** The scheme and the host are decided
independently in the dashboard code: the scheme comes from
`DASHBOARD_PUBLIC_TLS`, but the host comes from `DASHBOARD_HOST`, which on prod
is `192.168.1.44:3001` — the **Go backend port, with no TLS terminator in front
of it**. Flipping the scheme alone would advertise
`wss://192.168.1.44:3001/api/streams/inbound/...`, i.e. `wss` pointing at a
port that speaks plain HTTP. ts-store could not complete the handshake.

Verified in source at v0.59.3:
`internal/streaming/tsstore_stream.go:235-249` →
`internal/streaming/inbound_handler.go:395-401` (scheme swap only, host passed
through untouched).

**Required for this change:** pin it off explicitly so enabling front-end HTTPS
does not disturb the push path:

```yaml
# Front-end HTTPS (Caddy, :443) is independent of how ts-store nodes reach the
# push receiver, which is DASHBOARD_HOST=192.168.1.44:3001 — the backend port,
# no TLS. Letting this derive from dashboard_enable_https would advertise
# wss:// at a plaintext port and break push. Tracked in dashboard #299; unpin
# once callback URLs are derived from the public origin.
dashboard_public_tls: false
```

This is the case the pre-prod comment anticipated when it said to set
`dashboard_public_tls` explicitly "if the two ever diverge" — front-end TLS on,
callback path still plaintext. That is exactly prod's situation.

With it pinned, push keeps working unchanged and needs no re-registration.
Still worth confirming a live streaming panel after the deploy, since a push
that stops arriving looks like "no new data" rather than an error.

### Please do this as its own deploy

Not bundled with a version bump or other changes. First-time cert provisioning
on this LXC is the one genuinely new step, so if it misbehaves the cause should
be unambiguous.

## Why this shape and not `tailscale serve`

`tailscale serve --bg 80` would also work and is a one-liner, but it was
rejected:

- It puts a second, unmanaged proxy in front of the same port.
- It lives outside Ansible, so the box's description drifts from reality.
- The Caddy path already exists, is already proven on an identical host, and
  keeps the whole topology in the existing container stack.

## Prerequisites — believed already met, worth confirming

- **Image support**: needs the `{$CADDY_TLS_DIRECTIVE}` hook in the baked
  Caddyfile — commit `5deb552`, build ≥1964. Prod runs **0.59.3 / build 2346**,
  far past it. This was the blocker that staged the pre-prod change back in
  June; it is long gone.
- **Tailnet HTTPS Certificates + MagicDNS**: enabled at the tailnet level —
  pre-prod (LXC 104) provisioned a real Let's Encrypt cert despite being a
  tagged device. Prod is a *different* LXC and must provision its **own** cert
  on first start, so watch the Caddy logs on that first deploy.
- **tailscaled inside the LXC**: the role bind-mounts its socket into the Caddy
  container, gated on `dashboard_caddy_tls_directive`. Prod is on the tailnet
  and answers on `100.97.221.61`, so tailscaled is running — but confirm the
  socket path matches what the role expects for this container.

## REQUIRED: HTTP and HTTPS must BOTH keep working for a transition period

**This is a hard requirement of the request, and the pre-prod config does NOT
satisfy it as-is.** Please solve this as part of the change rather than
adopting pre-prod's behaviour verbatim.

### The problem, measured on pre-prod 2026-08-28

Pre-prod does not keep HTTP available. Caddy 308-redirects everything to
HTTPS, including the bare IP:

```
$ curl -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://100.123.43.23/
308 -> https://100.123.43.23/

$ curl -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
    http://dashboard-preprod.tailac8a95.ts.net/
308 -> https://dashboard-preprod.tailac8a95.ts.net/
```

The IP case is the damaging one. Following that redirect:

```
$ curl -L -o /dev/null -w 'ssl_verify=%{ssl_verify_result}\n' http://100.123.43.23/
ssl_verify=1        # cert validation FAILS
```

The Tailscale cert covers the `.ts.net` hostname, **not** the IP — so a client
that had `http://<IP>` bookmarked is redirected to an HTTPS URL with an invalid
cert. In a browser that is a hard interstitial, not a dismissible warning.

**Applied to prod as-is, this would break every bookmark and device still
pointing at `http://100.97.221.61` or `http://192.168.1.44` — with no
opt-out and no grace period.** That is the specific outcome this requirement
exists to prevent.

### Why it happens

The client image's Caddyfile is a **single site block keyed on `{$DOMAIN}`**.
Once `DOMAIN` is a hostname and a `tls` directive is present, Caddy's default
automatic HTTP→HTTPS redirect applies to that site — and the catch-all nature
of the block means IP requests get swept into the same redirect.

Note the compose template already publishes **`"80:80"` unconditionally** and
merely *adds* `"443:443"` when HTTPS is on, so both ports are bound. The
problem is purely Caddy's redirect behaviour, not port publishing.

### What's wanted

Both origins serving the app concurrently, for a transition period we control:

- `https://dashboard.tailac8a95.ts.net` — new, secure-context, unblocks the mic
- `http://100.97.221.61` and `http://192.168.1.44` — keep serving **200, not a
  redirect**, until we've migrated bookmarks/devices and explicitly ask for the
  redirect to be turned on

### This likely needs a dashboard-repo image change first — checked, not assumed

I inspected the baked Caddyfile in the running pre-prod client container. It
**starts directly with the site block** (`{$DOMAIN:localhost} {`) and has no
global options block, and `{$CADDY_TLS_DIRECTIVE}` is expanded *inside* that
site block.

Caddy requires `auto_https disable_redirects` to be in a **global options
block at the very top of the file**, before any site block. So the cleanest fix
**cannot be injected through the existing env hook** — the placeholder is in the
wrong position.

That means the likely path is:

1. **Dashboard repo** adds a second env placeholder ahead of the site block
   (e.g. `{$CADDY_GLOBAL_OPTIONS}`) so the deployer can supply global options,
   *or* bakes in an explicit `http://` site block alongside the TLS one.
2. **homelab-deploy** then sets it alongside the three TLS vars.

**I'll own step 1 in the dashboard repo** — please confirm which shape you want
(a general global-options placeholder vs. a purpose-built HTTP-parallel block)
and I'll ship it in the next release so the image is ready before you deploy.

If you find a way to get both origins serving 200 with the *current* image, that
is entirely fine and preferred — I'd rather not add an image knob we don't need.
The above is only to save you the dead end I already walked into.

### Sunset

Keep both live until we explicitly ask for HTTP to redirect or close. No
automatic cutover, no fixed date in this request — the whole point is that the
switch is deliberate and reversible.

## Do not break these

Several things depend on port 80 and should be verified after the change, not
assumed:

- **The kiosk** (`trv-kiosk-001`) — checked, and it actually points at
  `http://localhost:5174` (a local service on the kiosk itself), *not* directly
  at prod. So kiosk risk is lower than first assumed, but whatever backs
  localhost:5174 should still be confirmed working post-deploy.
- **The `/launch` launcher** — prod has `dashboard_launcher_enabled: true`
  (pre-prod does not). This is the iOS "Add to Home Screen" per-user PWA
  manifest path. It is the **main config difference between the two hosts**, so
  it is the piece least covered by the pre-prod precedent. Please confirm
  `/launch` still serves correctly over both HTTP and the new HTTPS origin.
- **`http://192.168.1.44`** — the LAN address, likely bookmarked on devices.
- **docker-stats collector** — writes over HTTP to the trv-srv-002 ts-store;
  outbound only, so it should be unaffected.

## Acceptance

1. `curl -o /dev/null -w '%{http_code} %{ssl_verify_result}'
   https://dashboard.tailac8a95.ts.net/` → `200 0`
2. Cert is publicly-trusted Let's Encrypt for the `.ts.net` SAN — no browser
   warning, no per-device root CA trust.
3. `http://100.97.221.61` and `http://192.168.1.44` return **200 directly — not
   a 308 redirect**. This is the criterion pre-prod currently fails; please
   check the status code, not just that the page eventually renders, since a
   redirect to an invalid-cert HTTPS URL can still look like "it loaded" in a
   terminal while being a hard failure in a browser.
4. `/launch` works on both origins.
5. Kiosk display still renders after a reboot.
6. In a browser at the HTTPS origin, `window.isSecureContext === true`.
   **This is the acceptance criterion the whole request exists for** — it is
   what unblocks the mic.
7. Streaming/push still delivers data after the callback scheme flips to
   `wss://` (see side effect above). Check a dashboard with a live streaming
   panel, not just that the page loads.

## Known constraint (already documented, repeated so it isn't re-discovered)

**Never use a bare-IP `dashboard_domain` with HTTPS.** Caddy's internal CA
issues an IP-SAN cert that Chromium, Firefox, and OpenSSL 3 all reject at the
handshake (only macOS LibreSSL tolerated it). Always a hostname. See
`docs/dashboard-https.md` → "Known limitation".

## Follow-on (not part of this request)

Once prod is HTTPS, a doorbell two-way-audio component becomes possible. That
work is **not** being requested here and has its own open questions — notably
whether the browser should reach go2rtc/Scrypted directly (currently a LAN
address the tailnet can't route, and mixed-content over HTTPS) or whether
signaling should be proxied through the dashboard's own origin. Flagged only so
the HTTPS change isn't later mistaken for the whole feature.
