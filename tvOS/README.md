# TRV Outpost — tvOS client

A native Apple TV app for viewing (and eventually interacting with) Outpost
dashboards.

**Status: scaffold.** Nothing here builds yet — this directory exists to hold
the Xcode project and to record the decisions made before writing any Swift.

## Why a native app at all

tvOS ships no web browser and no embeddable one. There is no Safari, no
Chrome, and no supported WKWebView-in-a-shell route — Apple omits it
deliberately. The third-party browsers that exist (tvOSBrowser, Moballo's
tvOS-Browser) are sideload/TestFlight projects leaning on private APIs, which
is not a foundation for a household display.

So "point the TV at `/kiosk`" is not available. The options were:

| Approach | Effort | Standalone |
|---|---|---|
| AirPlay `/kiosk` from an iPad/Mac | minutes | no — source device must stay awake |
| Pi/mini-PC in Chromium kiosk mode | ~an hour | yes (this is what `trv-kiosk-001` already does) |
| **Native tvOS app** | weeks | yes, and the only route that uses the Apple TV itself |

This directory is the third. The other two remain better answers if the goal
is just "a screen showing Outpost" — see the parent repo's kiosk role.

## Directory naming

The directory is **`tvOS/`**, matching Apple's own capitalisation.

macOS's APFS volume here is **case-insensitive**, so `cd tvos`, `ls tvos`, and
`open tvos` all resolve to this same directory with no alias, symlink, or
duplicate needed.

Do **not** add a lowercase `tvos` symlink or second directory. Git's index is
case-*sensitive* even on a case-insensitive filesystem, so committing both
creates two distinct paths that look identical on a Mac and are separate on
Linux — and CI runs on `ubuntu-latest`. That is a "works locally, breaks in
CI" bug generator, which is exactly what the single-name rule avoids.

## Design notes (decided, not yet built)

**Navigation is focus-based, not pointer-based.** The Siri Remote is a D-pad.
The web UI's click targets, hover states, and dense grids do not translate —
this app needs its own screen designs built around focus traversal, not a port
of the dashboard layout.

**Auth: an API key, and nothing more elaborate.** `GET /api/*` returns
`{"error":"Authentication required"}` unauthenticated, and the tvOS constraint
is that there is no comfortable text entry — typing a token on a D-pad keyboard
is miserable.

Resolved: the server already has an API-key IdP
(`server-go/internal/auth/idp/apikey.go`) accepting
`Authorization: Bearer trve_<base32>`. Verified against a running server — 200,
full dashboard list. So no device-pairing flow and no on-screen token entry
are needed; the key is supplied once and stored.

Two constraints on that:

- **Mint a SEPARATE key for the TV.** It lives on a device in a shared room, so
  it should not reuse a personal/admin key, and it should be read-only until
  control interaction is deliberately added.
- The open caveat in the parent repo still applies: kiosk auth needs sorting
  **before** Clerk is enabled on any deployment this app talks to.

**The model is the MOBILE viewer, not the desktop one.** tvOS and a phone face
the same problem from opposite ends: the author's 32×32-cell grid, scaled to
fit, is illegible on a small screen and equally wrong across a room. Both want
a restricted, non-authoring, read-oriented rendering of the same dashboard.

So `client/src/pages/MobileDashboardViewer.jsx` is the reference, and its
central decision carries over: **discard the author's grid geometry and stack
panels one per row in reading order**, so any existing dashboard works with no
re-authoring.

Reading order is worth porting properly rather than reimplementing. The web
version is `client/src/utils/mobilePanelOrder.js`: sort by (y, x), except a
rect `border` adornment groups the panels it encloses so they flow as a unit
instead of interleaving with a neighbouring cluster, nesting arbitrarily deep
(#180). That logic is pure and geometry-only — it is the piece to translate to
Swift first, and it is independently testable without any UI.

**Two things the mobile viewer has that tvOS deliberately does NOT get:**

1. **No stacked↔fit mode toggle.** The phone offers `FitToScreen` to fall back
   to the scaled canvas (`MobileDashboardViewer.jsx:311-312`, via
   `MobileViewModeContext`). On a TV the scaled canvas is never the better
   answer, and a mode the user can reach but should never pick is a trap.
   Stacked is the only mode; the whole `MOBILE_VIEW_FLOW`/`MOBILE_VIEW_FIT`
   mechanism has no tvOS equivalent.
2. **No dashboard-canvas flow.** Nothing renders the author's absolute panel
   geometry. Order is all that survives from the layout, exactly as on mobile.

**Where tvOS diverges from mobile even so:** a phone scrolls by touch, with no
concept of focus. A TV moves a focus ring with the D-pad, so a stack of panels
needs each row to be focusable and the list to scroll as focus advances. That
is the one part with no web counterpart to copy — the ordering and the panel
rendering port over, the traversal does not.

**Read-first.** Displaying dashboards is the valuable 80%. Control interaction
(toggles, dimmers) is the interesting part but needs the focus model settled
first — a mis-aimed D-pad press that turns off a light is a worse failure than
a chart that renders slightly wrong.

## Prerequisites

Toolchain confirmed present on the dev Mac (2026-08-29):

- **Xcode 26.6** (build 17F113)
- **tvOS 26.5 SDK** — `-sdk appletvos26.5` (device),
  `-sdk appletvsimulator26.5` (simulator)
- Simulators available: Apple TV 4K (3rd gen), Apple TV 4K (3rd gen, 1080p),
  Apple TV

Also needed:

- An Apple Developer account for on-device deployment. The Simulator works
  without one, which is enough for everything up to the first real-hardware
  test.
- A reachable Outpost server — see the parent `CLAUDE.md` for local dev setup.
  Note the auth constraint above: the Simulator can reach `localhost:3001`,
  but the app still needs a credential to get past
  `{"error":"Authentication required"}`.
