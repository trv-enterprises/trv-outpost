// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import "testing"

// stripTitleDivs mirrors the two-pass replace in
// migrateStripCustomCodeTitleDiv so the regexes can be unit-tested without a
// live Mongo.
func stripTitleDivs(code string) string {
	out := customCodeTitleGuardedRe.ReplaceAllString(code, "")
	out = customCodeTitleBareRe.ReplaceAllString(out, "")
	return out
}

func TestStripCustomCodeTitleDiv(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		wantChange bool
		wantAbsent string // substring that must be gone after strip (when wantChange)
	}{
		{
			name: "component-agent guarded shape",
			in: `const Component = ({ data, config }) => {
  const option = {};
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {config?.title && (
        <div style={{ height: '2.5rem', fontWeight: 600 }}>
          {config.title}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
      </div>
    </div>
  );
};`,
			wantChange: true,
			wantAbsent: "config.title",
		},
		{
			name: "chat-prompt bare shape with CARBON_COLORS",
			in: `const Component = ({ data, config }) => {
  const title = config?.title || '';
  return (<div style={{height:'100%',display:'flex',flexDirection:'column'}}><div style={{fontSize:'0.875rem',fontWeight:600,color:CARBON_COLORS.text,padding:'0.25rem 0.5rem'}}>{config?.title || ''}</div><div style={{flex:1,minHeight:0}}><ReactECharts option={option} style={{height:'100%'}} /></div></div>); }`,
			wantChange: true,
			wantAbsent: "{config?.title || ''}</div>",
		},
		{
			name: "no title reference — untouched",
			in: `const Component = ({ data }) => {
  const option = {};
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} />;
};`,
			wantChange: false,
		},
		{
			name: "config.title used in a variable, not a title div — untouched",
			in: `const Component = ({ config }) => {
  const label = config?.title || 'fallback';
  const option = { series: [{ name: label, data: [] }] };
  return <ReactECharts option={option} />;
};`,
			wantChange: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stripTitleDivs(tc.in)
			changed := got != tc.in
			if changed != tc.wantChange {
				t.Fatalf("changed=%v want %v\n--- got ---\n%s", changed, tc.wantChange, got)
			}
			if tc.wantChange && tc.wantAbsent != "" && contains(got, tc.wantAbsent) {
				t.Fatalf("expected %q to be stripped, still present:\n%s", tc.wantAbsent, got)
			}
			// ReactECharts body must always survive the strip.
			if !contains(got, "ReactECharts") {
				t.Fatalf("strip removed the chart body:\n%s", got)
			}
			// Idempotent: a second pass changes nothing.
			if again := stripTitleDivs(got); again != got {
				t.Fatalf("strip not idempotent:\n%s", again)
			}
		})
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
