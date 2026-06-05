---
sidebar_position: 8
---

# Dashboard Settings

Click the gear icon in the edit-mode toolbar to open the Dashboard Settings modal. The modal exposes the per-dashboard settings that actually drive runtime behavior:

| Setting | Description | Default |
|---------|-------------|---------|
| **Description** | Optional text shown in the dashboard tile view. | Empty |
| **Tags** | Free-form tags. The tag filter on the [tile view](viewing-dashboards.md) and the design-mode dashboard list match against these. | Empty |
| **Auto Refresh (seconds)** | How often each chart's data should re-fetch. Polling is paused while the browser tab is hidden so backgrounded dashboards don't keep hitting the server. Set to `0` to disable refresh entirely. Range 0–3600, step 5. | 30 |

## Auto Refresh — what it actually does

When `refresh_interval > 0`, every chart on the dashboard polls its data source on the configured cadence using the [`useData`](https://github.com/trv-enterprises/trv-outpost/blob/main/client/src/hooks/useData.js) hook. Polling has these properties:

- **Visibility-gated.** When the browser tab is hidden (user switched tabs, screen locked, kiosk dormant), the polling timer pauses. When the tab becomes visible again the chart refetches immediately and resumes the cadence — so a kiosk that wakes up shows fresh data right away.
- **Streaming sources are unaffected.** MQTT, ts-store push streaming, and bidirectional WebSocket connections push their own updates and ignore the refresh interval entirely.
- **Manual refresh.** The toolbar's refresh button forces every chart to refetch immediately, regardless of the configured interval.

## Applying Settings

1. Modify settings in the modal.
2. Click **Apply** to close the modal.
3. Changes appear as **Unsaved changes** in the toolbar.
4. Click **Save** in the main toolbar to persist.

Settings are saved alongside panel layout and dashboard name when you click Save.

## Removed Settings

A few legacy fields were removed from the modal in v0.8.4 because they had no runtime effect:

- **Theme (Light / Dark / Auto)** — the app is hardcoded to the Carbon g100 dark theme; the field was persisted but never read.
- **Make dashboard public** — placeholder for a future access-control feature; never enforced.
- **Allow export** — placeholder for a future export-permission feature; never enforced.
- **Title Scale** — only scaled the panel-title label on the legacy `datatable` chart type, which the editor stopped creating long ago. The slider had no visible effect on any current chart type.

The fields still exist on the server-side data model so old dashboard records round-trip without data loss, but they aren't read anywhere and aren't exposed in the editor.
