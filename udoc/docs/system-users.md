---
sidebar_position: 4
---

# System Users

**System users** are service principals — they authenticate by **API key**, not
by interactive sign-in. A system user exists only to own the keys that
non-browser callers present. This is admin-only management, found in Manage mode.

There are two main shapes:

- **Inbound integrations** — e.g. the ts-store webhook receiver. An external
  system calls the dashboard's API with a key owned by a system user.
- **Kiosks** — a TV or panel that loads a dashboard with the API key baked into
  the URL, so a display can run unattended with no human to sign in.

The **capability set** on each system user controls what its keys can do (View,
Design, Manage, Control). New system users default to **View** capability, which
is enough to call inbound webhook receivers and to load a read-only kiosk board.

## Managing system users

- **Create a system user** — provide a name. Capabilities default to View.
- **Generate an API key** — issue a key for any system user. The key is shown
  **once**, in a one-time-reveal modal; copy it then, because it can't be shown
  again. Pass it as `Authorization: Bearer <token>` (or in the kiosk URL).
- **Revoke a key** — any integration using that key immediately stops working.
- **Delete a system user** — permanently revokes every key it owns.

See [API Keys](api-keys.md) for the token format and how callers present it, and
[User Management](user-management.md) for regular (interactive) users and the
capability model. For kiosk URLs that embed a key, see
[Operating Modes → Kiosk Mode](modes.md#kiosk-mode).

> System users have no password and no interactive login — their only
> credential is the API key. Treat the keys as secrets: anyone holding a key has
> the system user's full capability set.
