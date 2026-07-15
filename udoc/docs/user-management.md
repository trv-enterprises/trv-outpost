---
sidebar_position: 17
---

# User Management

Manage user accounts from Manage Mode > Users. Requires the Manage capability.

## User List

The users page shows all accounts with:
- Name and email
- Capability tags (View, Control, Design, Manage)
- Status (Active / Inactive)
- Last modified date

Search and filter by name, email, or capabilities.

## Creating a User

1. Click **Create**
2. Enter a unique name (required)
3. Enter an email (optional)
4. Select capabilities:
   - **View**: Always available — access to View Mode
   - **Control**: Execute control commands (button presses, toggles, sliders, Frigate "Mark Reviewed"). Without this, controls render their state but the interactive affordance is disabled and the server rejects execute requests.
   - **Design**: Access to Design Mode (create/edit components, connections, dashboards)
   - **Manage**: Access to Manage Mode (users, settings, device types)
5. Click **Save**

Existing users created before v0.18.2 were backfilled with **Control**
to preserve behavior. New human users get View + Control by
default; pure read-only viewers can drop Control.

## Editing a User

Click a user row to open the detail page. You can modify:

- **Name**: Must be unique across all users
- **Email**: Optional contact information
- **Status**: Toggle between Active and Inactive. Inactive users cannot log in.
- **Capabilities** tab: Add or remove View, Control, Design, Manage access
- **Namespaces** tab: Limit which content the user can see (below)

## Namespace Access

Capabilities decide *what a user can do*; namespaces decide *what
content they can do it to*. The two are independent.

By default a user can see **every namespace** — that's what all
existing users have, and nothing changed for them.

To limit a user, open their **Namespaces** tab, turn on **Restrict to
specific namespaces**, and tick the ones they should have. That user
then sees only those namespaces in pickers and filters, sees only the
connections/components/dashboards inside them, and **cannot read data
through a connection they weren't granted** — enforced on the server,
not merely hidden.

A dashboard they can see that depends on something they can't still
opens; only the affected panels show an *Unauthorized* message, and
the out-of-reach item's name is never sent to their browser.

You can also grant access from the other direction: **Manage →
Namespaces → _(the namespace)_** has a *Users with access* list with an
**Add user** button. Both routes write the same thing.

:::note
**Manage is not namespace-limited.** Any user with the Manage
capability can create namespaces and grant any namespace to any user,
including themselves — otherwise nobody could grant the first one.
Restricting a manager still limits the content *they* see; it doesn't
limit who they can administer.
:::

See [Namespaces](namespaces.md#namespace-access) for the full picture.

## Pseudo Users

The system seeds three built-in pseudo users on first run:
- **Admin** — Full access (View, Control, Design, Manage)
- **Designer** — View, Control, and Design access
- **Support** — View access only

These can be modified but not deleted.

## System Users

A second user kind, **system users**, exists for non-interactive
integrations (inbound webhooks, MCP clients, scripts, etc.).
They live at **Manage → System Users**, own API keys, and cannot
sign in interactively. System users default to read-only with an
opt-in **Webhook** capability when creating one; admins can also
toggle **Control** on a system user for interactive kiosks.

---
