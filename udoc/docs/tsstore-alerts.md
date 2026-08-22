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
- **Edit** a rule in place with the pencil icon — the condition,
  cooldown, restart policy and dashboard link are all editable
  (see [below](#editing-a-rule)).
- **Delete** an alert — one alert is one rule, so this removes
  exactly the row you clicked (see [below](#one-alert-one-rule)).
- **Create new rules** via the **+ New rule** button, which opens a
  wizard at `/design/extensions/tsstore-alerts/new`.

## Creating a rule

The new-rule wizard walks through:

1. **Connection** — which ts-store the rule lives on. **Select** opens
   the same searchable connection picker the component editor uses,
   filtered to ts-store connections; search, namespace and tag filters
   all work there.
2. **Fires when** — what makes the rule trigger. Two kinds:
   - **A record matches a condition** — a SQL-like expression
     ts-store evaluates against each arriving record. This is the
     original behavior and the default.
   - **No data arrives for a while** — a *staleness* rule. Instead
     of inspecting records, it watches for their absence: give it a
     **max age** (`90s`, `5m`, `2h`) and it fires when the store has
     gone that long without a new record. Use it to catch a
     collector that died, which no condition can express — absence
     has no record to compare against.

  The two are mutually exclusive: picking one swaps the form field
  for the other, because ts-store rejects a rule carrying both.
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

**Endpoint-scoped connections** (a ts-store connection with no
pinned store — see [Connection types](connection-types.md#ts-store))
add a **Store** picker next to the connection: the rule registers on
the store you choose, and the picker lists only the stores the
connection's key can *manage* — alert administration is a per-store
`manage` grant under ts-store's scoped keys, so a read-only dashboard
key shows an empty picker with an explanation. A connection pinned to
one store registers rules on that store, as always, with no picker.

Before submitting, the wizard runs a quick auth probe against the
chosen ts-store connection (and store). If the connection's stored
API key doesn't pass ts-store's auth middleware, the submit button is
disabled with an explanation — saves you from a 401 surprise after
filling out the whole form.

## Editing a rule

The pencil on a rule row opens the same form the wizard uses,
prefilled from the rule as ts-store currently holds it. Saving
updates the rule **in place**, which keeps things a delete-and-
recreate would destroy: the alert's id, its creation date, its poll
cursor (so it resumes rather than replaying), and its fired counter.

Everything that *addresses* the rule is fixed once it exists, and the
form shows those as read-only:

- **The connection.** The update is sent to whichever ts-store the
  chosen connection points at, so this isn't a preference — it's how
  the rule is reached.
- **The store.** ts-store keeps each store's alerts separately — they
  live in that store's own directory, not at the server level — so a
  rule can't move between stores.
- **The delivery type.** ts-store keeps webhook and MQTT alerts in
  separate lists, so switching a rule between them isn't an edit.
- **The destination URL.** ts-store hides the credential part of a
  sink URL when it reads a rule back, and there is no way to tell a
  hidden credential from a real one on save — so the dashboard keeps
  the stored URL rather than risk overwriting a working one with a
  masked copy. Where a credential is present it displays masked
  (`********`), the same as secrets in the connection editor.

To change any of those, delete the rule and create a new one.

What stays editable is the rule's *behavior*: name, what makes it
fire (condition or max age — you can switch a rule between the two),
cooldown, restart policy, MQTT topic and QoS, and the dashboard
deep-link.

Rules on a connection whose key lacks **manage** on that store show
the pencil greyed out — you can read them, but not administer them.

## Who sees a fired alert

An alert is filed into a **namespace**, and only users with access to that
namespace see it on the bell. The rule editor's **File alerts into** field
chooses it.

The namespace is a property of the **rule**, not of its connection. A new
rule prefills the namespace you're currently working in — the same way a new
connection, component or dashboard does — and you can change it to anything
you have access to. Picking a connection from another namespace is allowed;
the editor says so, and nothing is blocked.

This is one of the few things that IS editable on an existing rule. Unlike
the connection, store, delivery type and destination URL, the namespace does
not *address* the rule — changing it moves nothing, it only changes who the
fired alerts are visible to.

Rules created before this existed, and rules created by the ts-store CLI,
carry no namespace of their own. Their alerts are filed into the delivering
connection's namespace instead. That fallback is arbitrary when the same
store is reachable through several connections in different namespaces —
whichever connection delivered the alert decides who sees it. Opening such a
rule in the editor prefills the field with the connection's namespace and
says where it came from — along with what saving will write onto the rule,
which is whatever the field shows. Leave it as prefilled and saving records
where the alerts already go; change it first and saving *moves* them, which
the editor says in as many words. The fallback itself stays, since the CLI
can always create rules without one.

## One alert, one rule

In ts-store, an **alert carries exactly one rule** — either a
condition or a staleness check — and exactly one sink. Deleting a row
therefore deletes precisely what you clicked; there are no sibling
rules to take with it.

To send the same rule to more than one destination, create one alert
per destination.

## Staleness rules

A staleness rule fires on the **absence** of data: if the store has
received nothing for longer than its **max age**, it fires. Worth
knowing before you rely on one:

- **It is per store, not per series.** It catches a collector that
  stopped writing entirely — not one field going quiet while others
  keep reporting.
- **A store that has never received data never fires.** There is no
  "last record" to measure against.
- **Recovery is silent.** When data starts flowing again the rule
  simply stops firing; there is no "resolved" notification.
- **There is no default max age, on purpose.** A collector polling
  every 60s should alert after a few missed polls, while an
  event-driven source (a door contact) can be legitimately quiet for
  days. Any single default would flood one of those cases.
- **Restart behavior doesn't apply.** A staleness rule is driven by
  the clock rather than a scan position, so it has no cursor to
  resume from — the editor hides the setting for this rule type.

When one fires, the bell row reads like `no data for 5m0s`.

:::note
Before ts-store issue #4 (post-v0.15.0), an alert held a *list* of
rules and deleting one removed all of them, so this page warned you
about siblings. That is no longer how it works, and the warning is
gone.
:::

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
