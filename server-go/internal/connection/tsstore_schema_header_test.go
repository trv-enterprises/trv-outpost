// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// steppedCompactResponse is the shape ts-store returns for a schema store when
// a query is BOTH aggregated (step / agg_window) and compact: a leading
// `_schema` header object with timestamp 0, then the bucketed records keyed by
// field index. Captured from a live `?step=15m&group_by=device&format=compact`.
const steppedCompactResponse = `{"objects":[
 {"timestamp":0,"block_num":0,"size":0,"data":{"_schema":{"1":"device","2":"occupancy","3":"illuminance"}}},
 {"timestamp":1791067500000000000,"block_num":0,"size":0,"data":{"1":"night-light-hall","2":0.5,"3":6.25}},
 {"timestamp":1791068400000000000,"block_num":0,"size":0,"data":{"1":"night-light-hall","2":0,"3":7.5}}
],"count":3,"data_type":"schema"}`

func steppedCompactObjects(t *testing.T) []dataResponse {
	t.Helper()
	var list dataListResponse
	if err := json.Unmarshal([]byte(steppedCompactResponse), &list); err != nil {
		t.Fatal(err)
	}
	return list.Objects
}

var nightlightSchema = &tsStoreSchema{Version: 1, Fields: []tsStoreSchemaField{
	{Index: 1, Name: "device", Type: "string"},
	{Index: 2, Name: "occupancy", Type: "int"},
	{Index: 3, Name: "illuminance", Type: "float"},
}}

func TestSplitSchemaHeader(t *testing.T) {
	objects := steppedCompactObjects(t)

	header, rest := splitSchemaHeader(objects)
	want := map[string]string{"1": "device", "2": "occupancy", "3": "illuminance"}
	if !reflect.DeepEqual(header, want) {
		t.Errorf("header = %v, want %v", header, want)
	}
	if len(rest) != 2 {
		t.Fatalf("len(rest) = %d, want the 2 data records", len(rest))
	}

	// Plain compact reads carry no header — nothing may be stripped.
	if header, rest := splitSchemaHeader(objects[1:]); header != nil || len(rest) != 2 {
		t.Errorf("headerless input: header = %v, len(rest) = %d; want nil, 2", header, len(rest))
	}
	// A real record that merely HAS a _schema field among others is data.
	mixed := []dataResponse{{Timestamp: 1, Data: json.RawMessage(`{"_schema":{"1":"a"},"value":3}`)}}
	if header, rest := splitSchemaHeader(mixed); header != nil || len(rest) != 1 {
		t.Errorf("multi-key record was treated as a header (header = %v)", header)
	}
	if header, rest := splitSchemaHeader(nil); header != nil || len(rest) != 0 {
		t.Errorf("empty input: header = %v, len(rest) = %d", header, len(rest))
	}
}

// TestSteppedSchemaStoreHasNoSchemaColumn is the regression for a stepped
// schema-store query (any range-picker dashboard) showing a `_schema` column
// and a row stamped 1970: the header object was converted like a data record.
func TestSteppedSchemaStoreHasNoSchemaColumn(t *testing.T) {
	wantColumns := []string{"timestamp", "device", "occupancy", "illuminance"}

	check := func(t *testing.T, columns []string, rows [][]interface{}) {
		t.Helper()
		if !reflect.DeepEqual(columns, wantColumns) {
			t.Errorf("columns = %v, want %v", columns, wantColumns)
		}
		if len(rows) != 2 {
			t.Fatalf("len(rows) = %d, want 2 (the header is not a row)", len(rows))
		}
		for _, row := range rows {
			if ts, _ := row[0].(int64); ts == 0 {
				t.Errorf("row stamped 0 (1970) — the schema header leaked through: %v", row)
			}
		}
		if rows[0][1] != "night-light-hall" || rows[0][2] != 0.5 {
			t.Errorf("first row = %v, want device + occupancy mapped by name", rows[0])
		}
	}

	// schema == nil: the header is then the ONLY index→name map, and the
	// column seeding must not dereference the missing schema.
	for name, schema := range map[string]*tsStoreSchema{"schema cached": nightlightSchema, "schema not fetched": nil} {
		t.Run("datasource/"+name, func(t *testing.T) {
			d := &TSStoreDataSource{dataType: models.TSStoreDataTypeSchema, schema: schema}
			rs, err := d.jsonToResultSet(steppedCompactObjects(t), map[string]interface{}{})
			if err != nil {
				t.Fatal(err)
			}
			check(t, rs.Columns, rs.Rows)
		})
		t.Run("adapter/"+name, func(t *testing.T) {
			a := &TSStoreAdapter{dataType: models.TSStoreDataTypeSchema, schema: schema}
			rs, err := a.jsonToRegistryResultSet(steppedCompactObjects(t), map[string]interface{}{})
			if err != nil {
				t.Fatal(err)
			}
			check(t, rs.Columns, rs.Rows)
		})
	}
}
