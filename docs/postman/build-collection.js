#!/usr/bin/env node
// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * build-collection.js
 *
 * Convert server-go/docs/swagger.json → a Postman v2.1 collection
 * grouped by tag, with collection-level Bearer auth and a disabled
 * legacy `X-User-ID` header pre-stamped on every request.
 *
 * The Swagger spec is the source of truth; this script keeps the
 * Postman collection in sync. Re-run after any change to API
 * handler annotations:
 *
 *     # 1. regenerate the swagger spec from Go annotations
 *     cd server-go
 *     $GOPATH/bin/swag init -g cmd/server/main.go -o docs
 *
 *     # 2. rebuild the Postman collection
 *     cd ../docs/postman
 *     node build-collection.js
 *
 * Outputs:
 *   trve-dashboard.postman_collection.json
 *   trve-dashboard.postman_environment.json   (only re-emitted if missing)
 *
 * The environment file is intentionally only created on first run so
 * a developer's local edits (a real `apiKey` value, a different
 * `baseUrl`) survive regeneration.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SWAGGER_PATH = path.join(REPO_ROOT, 'server-go', 'docs', 'swagger.json');
const COLLECTION_OUT = path.join(__dirname, 'trve-dashboard.postman_collection.json');
const ENV_OUT = path.join(__dirname, 'trve-dashboard.postman_environment.json');

const COLLECTION_NAME = 'TRVE Dashboard API';
const COLLECTION_DESCRIPTION =
  'Auto-generated from server-go/docs/swagger.json. Re-run docs/postman/build-collection.js to refresh after API changes.\n\n' +
  'Auth: collection-level `Authorization: Bearer {{apiKey}}` is on every request. The legacy `X-User-ID: {{userId}}` header is added to every request as a *disabled* header — flip it on per-request if you need the legacy identity-assertion path (dev only).\n\n' +
  'Variables you set in the environment:\n' +
  '- `baseUrl` — e.g. `http://localhost:3001`\n' +
  '- `apiKey`  — `trve_…` token from Manage Mode → API Keys\n' +
  '- `userId`  — optional GUID, only used if you switch a request to the legacy header path';

// ─────────────────────────────────────────────────────────────────────
// Conversion
// ─────────────────────────────────────────────────────────────────────

const swagger = JSON.parse(fs.readFileSync(SWAGGER_PATH, 'utf8'));

// NOTE on basePath: the project's swag annotations declare absolute
// `@Router /api/foo` paths AND swagger.json sets `basePath: /api`. The
// real server serves at `/api/foo`, so the basePath is wrong about
// itself. We ignore basePath when the Router path already starts with
// `/api/` (which it always does in this codebase). Documented here so
// nobody "fixes" it back later.
const basePath = swagger.basePath || '';
const ignoreBasePath = basePath === '/api';

// Group operations by tag. Untagged → "Other". Tags are
// case-normalized so `System` and `system` (which both exist in the
// spec) collapse into one folder.
const folders = new Map(); // canonicalTag → { displayName, items }

for (const [rawPath, pathItem] of Object.entries(swagger.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const op = pathItem[method];
    if (!op) continue;
    const rawTag = (op.tags && op.tags[0]) || 'Other';
    const canonical = rawTag.toLowerCase();
    const folder = folders.get(canonical) || { displayName: prettifyTag(rawTag), items: [] };
    folder.items.push(buildItem(method, rawPath, op));
    folders.set(canonical, folder);
  }
}

const folderNodes = [...folders.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([canonical, folder]) => ({
    name: folder.displayName,
    description: `${canonical} endpoints (${folder.items.length}).`,
    item: folder.items.sort((a, b) => a.name.localeCompare(b.name)),
  }));

// Hand-authored MCP example — /mcp/* is not in Swagger.
folderNodes.push(buildMcpFolder());

const collection = {
  info: {
    _postman_id: deterministicId(COLLECTION_NAME),
    name: COLLECTION_NAME,
    description: COLLECTION_DESCRIPTION,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }],
  },
  item: folderNodes,
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3001', type: 'string' },
  ],
};

fs.writeFileSync(COLLECTION_OUT, JSON.stringify(collection, null, 2) + '\n');
console.log(`✓ Wrote ${path.relative(REPO_ROOT, COLLECTION_OUT)}`);

// Only seed the environment file on first run so local edits survive.
if (!fs.existsSync(ENV_OUT)) {
  const env = {
    id: deterministicId('environment'),
    name: 'TRVE Dashboard (local)',
    values: [
      { key: 'baseUrl', value: 'http://localhost:3001', type: 'default', enabled: true },
      { key: 'apiKey', value: '', type: 'secret', enabled: true },
      { key: 'userId', value: '', type: 'default', enabled: true },
    ],
    _postman_variable_scope: 'environment',
  };
  fs.writeFileSync(ENV_OUT, JSON.stringify(env, null, 2) + '\n');
  console.log(`✓ Wrote ${path.relative(REPO_ROOT, ENV_OUT)} (first run)`);
} else {
  console.log(`· Kept ${path.relative(REPO_ROOT, ENV_OUT)} as-is`);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function buildItem(method, rawPath, op) {
  // See basePath note at top of file for why we conditionally drop it.
  const prefixed = ignoreBasePath && rawPath.startsWith('/api/')
    ? rawPath
    : basePath + rawPath;
  const fullPath = prefixed.replace(/^\/+/, '');
  const pathParts = fullPath.split('/').filter(Boolean);

  const queryParams = (op.parameters || [])
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: '',
      description: oneLine(p.description) || (p.required ? 'required' : 'optional'),
      disabled: !p.required,
    }));

  const pathVars = (op.parameters || [])
    .filter((p) => p.in === 'path')
    .map((p) => ({
      key: p.name,
      value: '',
      description: oneLine(p.description) || 'required',
    }));

  const url = {
    raw: '{{baseUrl}}/' + fullPath + (queryParams.length ? buildQueryString(queryParams) : ''),
    host: ['{{baseUrl}}'],
    path: pathParts.map((seg) => seg.replace(/^\{(.+)\}$/, ':$1')),
  };
  if (queryParams.length) url.query = queryParams;
  if (pathVars.length) url.variable = pathVars;

  const headers = [
    {
      key: 'X-User-ID',
      value: '{{userId}}',
      description: 'Legacy identity-assertion path (dev only). Disabled by default — Bearer token (collection auth) is preferred.',
      disabled: true,
    },
  ];

  const bodyParam = (op.parameters || []).find((p) => p.in === 'body');
  let body;
  if (bodyParam) {
    headers.unshift({ key: 'Content-Type', value: 'application/json' });
    const example = exampleForSchema(bodyParam.schema);
    body = {
      mode: 'raw',
      raw: JSON.stringify(example, null, 2),
      options: { raw: { language: 'json' } },
    };
  } else if (['post', 'put', 'patch'].includes(method) && (op.consumes || []).includes('application/json')) {
    headers.unshift({ key: 'Content-Type', value: 'application/json' });
    body = { mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } };
  }

  const description = [
    op.summary,
    op.description,
    op.responses ? `\nResponses: ${Object.keys(op.responses).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const item = {
    name: op.summary || `${method.toUpperCase()} ${rawPath}`,
    request: {
      method: method.toUpperCase(),
      header: headers,
      url,
      description,
    },
    response: [],
  };
  if (body) item.request.body = body;
  return item;
}

function buildQueryString(qs) {
  if (!qs.length) return '';
  return '?' + qs.map((q) => `${q.key}=${encodeURIComponent(q.value || '')}`).join('&');
}

function buildMcpFolder() {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'postman', version: '1.0' },
    },
  };
  const listBody = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const callBody = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_connections', arguments: {} },
  };
  const baseHeaders = [
    { key: 'Content-Type', value: 'application/json' },
    {
      key: 'X-User-ID',
      value: '{{userId}}',
      description: 'Legacy path — prefer collection-level Bearer.',
      disabled: true,
    },
  ];

  return {
    name: 'MCP (JSON-RPC, /mcp/*)',
    description:
      'External-agent MCP surface. Same Bearer auth as `/api/*` since v0.9.0. Not in Swagger; these requests are hand-authored.',
    item: [
      mcpItem('initialize', initBody, baseHeaders),
      mcpItem('tools/list', listBody, baseHeaders),
      mcpItem('tools/call (list_connections)', callBody, baseHeaders),
    ],
  };
}

function mcpItem(name, body, headers) {
  return {
    name,
    request: {
      method: 'POST',
      header: headers,
      url: {
        raw: '{{baseUrl}}/mcp/message',
        host: ['{{baseUrl}}'],
        path: ['mcp', 'message'],
      },
      body: {
        mode: 'raw',
        raw: JSON.stringify(body, null, 2),
        options: { raw: { language: 'json' } },
      },
      description: 'JSON-RPC request to the MCP message endpoint.',
    },
    response: [],
  };
}

function exampleForSchema(schema, depth = 0) {
  if (!schema || depth > 5) return null;
  if (schema.$ref) return exampleForSchema(resolveRef(schema.$ref), depth + 1);
  if (schema.example !== undefined) return schema.example;
  if (schema.enum && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) {
        out[k] = exampleForSchema(v, depth + 1);
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out['<key>'] = exampleForSchema(schema.additionalProperties, depth + 1);
      }
      return out;
    }
    case 'array':
      return [exampleForSchema(schema.items || {}, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
      return '';
    default:
      return null;
  }
}

function resolveRef(ref) {
  // "#/definitions/foo.bar"
  const parts = ref.replace(/^#\//, '').split('/');
  let node = swagger;
  for (const p of parts) node = node && node[p];
  return node || {};
}

function oneLine(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function prettifyTag(tag) {
  // Existing tags are inconsistent (mixed case + dashes). Normalize.
  const map = {
    ai: 'AI',
    'api-keys': 'API Keys',
    auth: 'Auth',
    charts: 'Charts',
    config: 'Config',
    controls: 'Controls',
    dashboards: 'Dashboards',
    datasources: 'Datasources (legacy alias of /connections)',
    debug: 'AI Debug',
    'device-types': 'Device Types',
    devices: 'Devices',
    frigate: 'Frigate (NVR)',
    mcp: 'MCP',
    namespaces: 'Namespaces',
    registry: 'Registry (type catalog)',
    settings: 'Settings',
    system: 'System',
    tags: 'Tags',
    users: 'Users',
  };
  const key = tag.toLowerCase();
  return map[key] || tag;
}

function deterministicId(seed) {
  // Postman expects a UUID-shaped string. Derive deterministically so
  // the file diff stays stable across regenerations.
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
