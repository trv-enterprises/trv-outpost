---
sidebar_position: 21
---

# Grid & Layout System

## Grid Fundamentals

Dashboards use a CSS grid with fixed cell dimensions:

| Property | Value |
|----------|-------|
| **Cell width** | 32 px |
| **Cell height** | 32 px |
| **Gap between cells** | 4 px |

Panels are positioned and sized in **grid cells** (columns × rows). A panel with size 6 × 4 occupies 6 columns and 4 rows.

## Dimension Presets

Layout dimension presets define the canvas a dashboard targets — the maximum pixel area panels can occupy. Common presets:

| Preset | Resolution | Use Case |
|--------|-----------|----------|
| 1728 × 1117 MAC | 1728 × 1117 | MacBook displays |
| 1920 × 1080 HD | 1920 × 1080 | Standard HD monitors |
| 2560 × 1440 2K | 2560 × 1440 | QHD / 2K monitors |
| 3840 × 2160 4K | 3840 × 2160 | 4K / UHD displays |

The number of grid cells available for a preset is computed from the canvas size minus a fixed viewer-chrome budget (the application header is 48 px, the toolbar is 57 px, plus a 4 px padding):

```
cols = floor( canvas_width            / 36 )
rows = floor( (canvas_height - 105)   / 36 )
```

(The stride is `cell + gap = 36`; the `-105` is the vertical chrome minus one gap, which cancels out cleanly.)

Worked examples:

| Canvas | Available cells |
|--------|-----------------|
| 2560 × 1440 | **71 cols × 37 rows** |
| 1920 × 1080 | **53 cols × 27 rows** |
| 1280 × 720  | **35 cols × 17 rows** |

Admins manage available presets in [System Settings](system-settings.md). Authors pick a preset per-dashboard from the dimension dropdown in the editor toolbar.

## Boundary Lines

In edit mode, red dashed lines indicate the dimension boundary:

- **Right edge**: vertical red dashed line at the maximum column
- **Bottom edge**: horizontal red dashed line at the maximum row

Panels cannot be dragged or resized beyond these boundaries.

## Fit-Mode Scaling

In view mode, the **fit mode picker** in the toolbar scales the entire grid to fit your viewport. Four modes are available:

- **Fit to window** — uniform scale, preserves aspect ratio (safe default)
- **Fit to width** — fill width exactly, scroll vertically if needed
- **Stretch to fill** — fill both axes independently (may distort round elements)
- **Actual size** — render at native pixel dimensions, scroll as needed

Your fit-mode preference is **per-dashboard, per-user**. New dashboards inherit the deployment-wide default (configured in [System Settings](system-settings.md)). See [Dashboard Navigation & Controls](viewer-controls.md#fit-modes) for the full description of each mode.

In **edit mode**, fit modes are bypassed — the editor uses its own zoom controls (10%-100%) for proportional scaling, so panel-positioning math stays predictable while you work.

## Panel Positioning

Panel positions use zero-indexed grid coordinates:

- `x`: column position (0 = leftmost)
- `y`: row position (0 = topmost)
- `w`: width in columns
- `h`: height in rows

In CSS Grid, these translate to:

```
gridColumn: (x + 1) / span w
gridRow:    (y + 1) / span h
```

Panels cannot overlap, and every panel must satisfy `x + w <= cols` and `y + h <= rows`.

## "12-column" vs the runtime grid

You'll occasionally see "12 columns" mentioned in design discussion — that's the IBM Carbon **responsive breakpoint** convention used for the application's own page layout (sidebars, toolbars, settings forms). It is **not** the runtime dashboard grid. Dashboard panels live on the 32 × 32 px cell grid described above; the column count is whatever the canvas supports, not a fixed 12.
