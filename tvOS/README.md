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

**The API requires authentication.** `GET /api/*` returns
`{"error":"Authentication required"}` without a token. The app needs a
credential path, and the tvOS constraint is that there is no comfortable text
entry — typing a token on a D-pad keyboard is miserable. Options to weigh:

- a device-pairing flow (TV shows a short code, the user approves it from the
  web UI on a phone/laptop), or
- the existing system-user / kiosk-token pattern already used for
  `trv-kiosk-001`, which was built for exactly this "no human at the keyboard"
  problem.

The second is likely the quicker path and reuses a solved problem. Note the
open caveat in the parent repo: kiosk auth needs sorting **before** Clerk is
enabled on any deployment this app talks to.

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
