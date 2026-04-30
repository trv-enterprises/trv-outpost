// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package database

import "go.mongodb.org/mongo-driver/mongo/options"

// CaseInsensitiveCollation is the project-wide collation for user-facing collections.
// Locale "en" + strength 2 = case-insensitive, accent-sensitive.
//
// When applied at the collection level, every query, index, and uniqueness
// constraint on the collection inherits this collation automatically. This means
// name lookups like FindByName become case-insensitive, and unique indexes on
// name reject "HVAC" when "hvac" already exists.
var CaseInsensitiveCollation = &options.Collation{
	Locale:   "en",
	Strength: 2,
}

// CollationCollections lists the collections that should use case-insensitive
// collation. Only includes collections where names are user-facing and
// duplication-sensitive. System-keyed collections (settings, app_config,
// ai_sessions, control_schemas, migrations) are intentionally excluded because
// their keys are programmatic identifiers where case-sensitivity is correct.
var CollationCollections = []string{
	"connections",
	"dashboards",
	"components",
	"layouts",
	"users",
	"devices",
	"device_types",
}
