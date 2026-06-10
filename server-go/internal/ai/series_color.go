// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"regexp"
	"strconv"
	"strings"
)

// seriesColorPalette mirrors the ACTIVE-THEME categorical palette in
// client/src/config/theme.js (CATEGORICAL_PALETTE / CATEGORICAL_NAMES). The app
// runs the g100 DARK theme, so this is the Carbon DARK categorical palette
// (lighter variants that pop on a dark canvas). A user/agent references colors
// by 1-based number or Carbon name. Keep in lockstep with config/theme.js — if
// the app theme changes there, update this list to the matching palette.
var seriesColorPalette = []struct {
	Name string
	Hex  string
}{
	{"purple60", "#8a3ffc"},
	{"cyan40", "#33b1ff"},
	{"teal60", "#007d79"},
	{"magenta40", "#ff7eb6"},
	{"red50", "#fa4d56"},
	{"red10", "#fff1f1"},
	{"green30", "#6fdc8c"},
	{"blue50", "#4589ff"},
	{"magenta60", "#d12771"},
	{"yellow40", "#d2a106"},
	{"teal40", "#08bdba"},
	{"cyan20", "#bae6ff"},
	{"orange60", "#ba4e00"},
	{"purple30", "#d4bbff"},
}

var hexRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// resolveSeriesColor turns a series-color token into a canonical hex:
//   - 1-based palette number ("1".."14")
//   - Carbon name ("purple70", case-insensitive)
//   - hex ("#6929c4")
//
// Anything empty/unrecognized resolves to "" (the caller treats "" as the
// automatic palette for that series). Mirrors resolveSeriesColor in the JS
// option-helpers so the editor and agent agree.
func resolveSeriesColor(token string) string {
	t := strings.TrimSpace(token)
	if t == "" {
		return ""
	}
	if hexRe.MatchString(t) {
		return strings.ToLower(t)
	}
	if n, err := strconv.Atoi(t); err == nil {
		if n >= 1 && n <= len(seriesColorPalette) {
			return seriesColorPalette[n-1].Hex
		}
		return ""
	}
	lower := strings.ToLower(t)
	for _, c := range seriesColorPalette {
		if strings.ToLower(c.Name) == lower {
			return c.Hex
		}
	}
	return ""
}
