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
- **Capabilities**: Add or remove View, Control, Design, Manage access

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
