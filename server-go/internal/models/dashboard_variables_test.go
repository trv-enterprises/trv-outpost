// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "testing"

func TestValidateVariables(t *testing.T) {
	tests := []struct {
		name    string
		vars    []DashboardVariable
		wantErr bool
	}{
		{
			name:    "empty",
			vars:    nil,
			wantErr: false,
		},
		{
			name: "connection_swap + filter + range coexist",
			vars: []DashboardVariable{
				{Mode: VariableModeConnectionSwap},
				{Mode: VariableModeFilter},
				{Mode: VariableModeRange},
			},
			wantErr: false,
		},
		{
			name: "two filter variables rejected",
			vars: []DashboardVariable{
				{Mode: VariableModeFilter},
				{Mode: VariableModeFilter},
			},
			wantErr: true,
		},
		{
			name: "two range variables rejected",
			vars: []DashboardVariable{
				{Mode: VariableModeRange},
				{Mode: VariableModeRange},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateVariables(tt.vars)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateVariables() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
