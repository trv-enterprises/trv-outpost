# Database

MongoDB 7 is the single primary database for everything the dashboard
persists: connections, dashboards, components, users, devices, AI
sessions, layouts, and runtime configuration.

## Collections

| Collection       | Contents                                                |
| ---------------- | ------------------------------------------------------- |
| `datasources`    | Connection definitions (SQL, API, MQTT, Frigate, etc.)  |
| `dashboards`     | Dashboards with their panel layout and settings         |
| `charts`         | Components — charts, controls, displays (with versions) |
| `layouts`        | Named layout presets that dashboards can reference      |
| `users`          | User records with GUID + active flag                    |
| `devices`        | Device instances (Zigbee, Caséta, etc.)                 |
| `device_types`   | Device type metadata with command schemas               |
| `ai_sessions`    | AI Builder session state with TTL                       |
| `app_config`     | Runtime app config (system + per-user)                  |
| `settings`       | Admin-facing settings surfaced through Manage mode      |
| `control_schemas`| Reusable command schemas shared across device types    |
| `migrations`     | One-row-per-migration marker collection                 |

"Connection" is the user-facing term for what the code calls a
`datasource` (the collection name, model type, and repository all use
the internal term for backwards compatibility with existing records).

## Case-insensitive collation

Every collection where a user-facing name is stored uses MongoDB's
case-insensitive collation (`locale=en, strength=2`). Applied to:

- `datasources`, `dashboards`, `charts`, `layouts`, `users`, `devices`,
  `device_types`

With this collation, equality queries and unique-index constraints
ignore case — `HVAC` and `hvac` cannot both exist as connection
names. System-keyed collections (`settings`, `app_config`,
`ai_sessions`, `migrations`, `control_schemas`) intentionally use the
default binary comparison because their keys are programmatic
identifiers, not human labels.

**`$regex` queries do NOT respect collation** — this is a MongoDB
limitation. The `FindAllLatest` and dashboard list handlers still pass
`$options: "i"` explicitly on regex name filters for that reason.
Equality and `$in` queries do use the collation automatically.

## Migrations

The migrations framework lives at
`server-go/internal/database/migrations.go`. Each migration has a
stable name, is recorded in the `migrations` collection once applied,
and is idempotent.

Migrations run at server startup **before** the per-repository
`CreateIndexes` calls, because some of them (notably the collation
migration) rebuild collections, which wipes their indexes. The
startup order is:

1. Connect to MongoDB
2. Instantiate repositories
3. `database.RunMigrations(ctx, db)`
4. `mongodb.CreateIndexes(ctx)` (datasources + dashboards)
5. Per-repository `CreateIndexes` calls (charts, users, devices,
   device_types, ai_sessions, config, settings)

The collation migration (`collation_case_insensitive_v1`) checks each
target collection's current collation via `listCollections`. If
collation is already set, it's a no-op. Otherwise it creates a
temporary copy with the correct collation, copies documents in batches
of 500, drops the original, and renames the copy into place. Safe to
rerun — the migration tracking row is only written on success.

The namespacing migration (`namespacing_v1`) introduces the
namespace dimension to existing data:

1. Upserts the `default` namespace row in the `namespaces` collection.
2. UpdateMany on `datasources`, `charts`, `dashboards` to set
   `namespace: "default"` where the field is missing or empty.
3. Resolves `(namespace=default, name)` collisions by auto-renaming
   the younger duplicates (`name-2`, `name-3`, …). Charts handle
   versioning by grouping per logical id first; every version row of
   a renamed chart picks up the same new name.
4. Drops the legacy `name_1` unique indexes on `datasources` and
   `dashboards`. The next `CreateIndexes` call replaces them with
   compound `(namespace, name)` unique indexes (see mongodb.go).

## Indexing strategy

Indexes are created per collection from functions in either
`internal/database/mongodb.go` (datasources, dashboards) or each
repository file's `CreateIndexes` method. The general patterns:

- **Unique indexes on name** where case-insensitive uniqueness is
  wanted (layouts, users, devices, device_types). These inherit the
  collection's collation. For namespaced entities (datasources,
  charts, dashboards), the unique index is compound on
  `(namespace, name)` so the same name can exist in different
  namespaces — see [data-model.md#namespace](data-model.md#namespace).
- **Compound filter + sort indexes** for common list queries — the
  leading fields cover the filter, the trailing field covers the
  sort. Example: `{type: 1, created_at: -1}` on datasources supports
  "list all SQL connections, newest first" as a single index scan.
- **Tags arrays** indexed with a leading `tags` field so `$in`
  queries against tag filters hit an index directly. Tags are
  normalized (lowercase, kebab) before storage, and the cross-entity
  `/api/tags` endpoint uses `$unwind` + `$group` aggregations to
  build per-entity usage counts.
- **Health monitoring fields** on datasources (`health.status`,
  `health.last_check`) indexed for the background health-check
  sweep.
- **TTL index** on `ai_sessions.expires_at` so the collection
  self-cleans.

## Secret masking

Any persisted config that contains credentials (SQL passwords, API
bearer tokens, MQTT passwords, Frigate passwords, TSStore API keys)
runs through `SanitizeForAPI` before being returned from a list or
detail endpoint. Secrets are replaced with `SecretMaskedValue`
(`"********"`) so the frontend never sees real values.

When the user edits an existing connection and submits the same masked
value unchanged, the service's update path resolves the masked
placeholder back to the stored real value so nothing is lost. This is
why `Test connection` on the edit form can work against the current
form values even when the user hasn't re-typed the password.

## Related docs

- [Backend architecture](backend.md) — where repositories and services
  fit in the layered design
- [Connections](connections.md) — per-type config fields and which
  ones are secret
- [Streaming](streaming.md) — the ring buffer and retained-state cache
  sit inside the streaming subsystem, not the MongoDB persistence layer
