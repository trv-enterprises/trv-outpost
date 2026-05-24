---
title: ts-store Alerts
sidebar_position: 2
---

# ts-store Alerts

The ts-store Alerts extension at
`/design/extensions/tsstore-alerts` is a central management page
for alert rules across **every ts-store connection** in your
deployment. ts-store itself stores the rules (one ts-store per
connection); the dashboard is an editor on top of ts-store's API.

When you open the page, the dashboard walks every ts-store
connection in parallel, asks each for its current alert rule list,
and renders one flat table. A single unreachable ts-store doesn't
blank the page — it surfaces as a row-level error and the other
connections still render normally.

## What you can do

- **Browse** all alert rules across every ts-store, filterable with
  the search box (matches rule name, condition, connection name,
  and store name).
- **Open** a rule's detail view (read-only) by clicking its row's
  view icon.
- **Delete** an entire alert (which removes all its rules; ts-store
  has no per-rule delete — see the note below).
- **Create new rules** via the **+ New rule** button, which opens a
  wizard at `/design/extensions/tsstore-alerts/new`.

## Creating a rule

The new-rule wizard walks through:

1. **Connection** — which ts-store the rule lives on.
2. **Condition** — the alert predicate (a SQL-like expression
  ts-store evaluates against incoming data).
3. **Transport** — how ts-store fires the alert when the condition
  trips. Two choices:
   - **Webhook** — ts-store POSTs the alert payload to a URL on
     this dashboard. The dashboard mints a per-rule secret and
     builds the URL automatically, so you don't manage tokens
     yourself.
   - **MQTT** — ts-store publishes the payload to an MQTT topic.
     The wizard reads broker credentials from an existing MQTT
     connection in the dashboard so they don't need to be re-typed.
4. **Target dashboard** (optional) — the dashboard to deep-link to
   when a user clicks the alert in the notification bell. ts-store
   carries this through its `external_ref` field; the dashboard
   resolves the ID to a name in the table.

Before submitting, the wizard runs a quick auth probe against the
chosen ts-store connection. If the connection's stored API key
doesn't pass ts-store's auth middleware, the submit button is
disabled with an explanation — saves you from a 401 surprise after
filling out the whole form.

## Why "delete the whole alert" instead of "delete one rule"?

In ts-store, alerts live as a **list of rules under a single alert
record**. A single alert can have several rules — same condition,
different transports, different cooldowns. ts-store doesn't expose
per-rule delete; the smallest deletable unit is the entire alert.

When you click **delete** on a row, the confirmation modal counts
the sibling rules under the same alert and warns you. If the alert
has rules besides the one you clicked, deleting nukes all of them
together.

## Where the rule list comes from

The dashboard does not cache or store rules. Every time you open
the page (or hit refresh), it fan-queries every ts-store connection
and returns a fresh union. This means:

- Rules created by ts-store's CLI or directly via its API show up
  here without any dashboard-side import step.
- Stale data is impossible — what you see is what ts-store had a
  few hundred milliseconds ago.
- If a ts-store is slow or unreachable, the rest of the page still
  loads and the missing connection surfaces as an error row.

## How this differs from the notification bell

The notification bell in the dashboard header shows **fired
alerts** — instances where a ts-store rule actually tripped and
sent a webhook to the dashboard's inbound receiver. Those are
stored locally in the dashboard's own `alerts` collection.

The Alerts extension page, by contrast, shows **rule definitions**
— the configurations that *would* fire under the right conditions.
The two surfaces are deliberately separate: rules live on
ts-store, fired alerts live on the dashboard.

## Disabling the extension

Admins can turn the alert-management page off in **Manage →
Settings → Extensions → ts-store Alerts**. When off:

- The sidebar link under Design → Extensions disappears.
- Direct navigation to `/design/extensions/tsstore-alerts`
  redirects to `/design`.
- The `/api/tsstore-alerts/*` endpoints return
  `403 extension_disabled`.

Chart queries against ts-store connections and inbound alert
webhooks continue to work unaffected — only the rule-management
page is gated.

See the [Extensions overview](./extensions-overview.md) for the
broader extension toggle model.
