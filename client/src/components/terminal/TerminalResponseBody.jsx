// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useMemo, useState } from 'react';
import { IconButton } from '@carbon/react';
import {
	ChevronRight,
	ChevronDown,
	ChevronUp,
	ExpandAll,
	CollapseAll,
	Reset,
} from '@carbon/icons-react';
import './TerminalResponseBody.scss';

// EdgeLake response bodies come in a few shapes:
//  - real JSON object/array (e.g. `get status`, `blockchain get *`)
//  - JSON string that itself contains JSON (rare, but happens when a
//    node escapes its response through one layer)
//  - tabular plain text (e.g. `test network`, `get processes`)
//  - short scalar (e.g. `set debug on` echoing back the new state)
//  - empty body (handled upstream, never reaches here)
//
// We try JSON.parse, and on success render the structured view. On
// failure we fall through to plain monospace text — every legacy path
// keeps working.

const INDENT = 2;

// Default-open depth on initial render. Top-level + first nested layer
// open so the root's immediate children are visible without a click;
// deeper objects/arrays land collapsed so a `blockchain get *` payload
// doesn't bury the screen. `depth < DEFAULT_OPEN_DEPTH` is the rule,
// so 2 = root (depth 0) and its direct children (depth 1) are open.
const DEFAULT_OPEN_DEPTH = 2;

function tryParseJSON(raw) {
	if (typeof raw !== 'string') return { ok: false };
	const trimmed = raw.trim();
	if (!trimmed) return { ok: false };
	// JSON values must start with one of these. EdgeLake plain-text
	// responses don't, and this short-circuit avoids burning cycles on
	// large tabular outputs.
	const first = trimmed[0];
	if (first !== '{' && first !== '[' && first !== '"') return { ok: false };
	try {
		const parsed = JSON.parse(trimmed);
		// Double-encoded case: parse succeeded but the result is still a
		// string that itself looks like JSON. Try one more level.
		if (typeof parsed === 'string') {
			const inner = parsed.trim();
			if (inner.startsWith('{') || inner.startsWith('[')) {
				try {
					const reparsed = JSON.parse(inner);
					return { ok: true, value: reparsed };
				} catch {
					return { ok: false };
				}
			}
			return { ok: false };
		}
		return { ok: true, value: parsed };
	} catch {
		return { ok: false };
	}
}

function valueType(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v; // string, number, boolean, object
}

// Walk the value tree and return every container path with its depth.
// Paths are encoded as "$" for root and "$.key.0.nested" for nested
// entries; depth is the recursion level (root = 0, root's children = 1,
// …). The step-buttons use depth to find "the deepest open layer" or
// "the shallowest closed layer" and act on every path at that depth.
// Empty containers are skipped — they're not expandable in the UI.
function collectContainerPaths(value, prefix = '$', depth = 0) {
	const t = valueType(value);
	if (t !== 'object' && t !== 'array') return [];
	const entries =
		t === 'array' ? value.map((v, i) => [i, v]) : Object.entries(value);
	if (entries.length === 0) return [];
	const out = [{ path: prefix, depth }];
	for (const [k, v] of entries) {
		out.push(...collectContainerPaths(v, `${prefix}.${k}`, depth + 1));
	}
	return out;
}

function ScalarToken({ value }) {
	const t = valueType(value);
	if (t === 'string') {
		return <span className="trb-string">&quot;{value}&quot;</span>;
	}
	if (t === 'number') {
		return <span className="trb-number">{String(value)}</span>;
	}
	if (t === 'boolean') {
		return <span className="trb-bool">{String(value)}</span>;
	}
	if (t === 'null') {
		return <span className="trb-null">null</span>;
	}
	// Shouldn't reach here for objects/arrays — they go through Tree.
	return <span>{String(value)}</span>;
}

function previewSummary(value) {
	if (Array.isArray(value)) {
		const n = value.length;
		return `[ … ${n} ${n === 1 ? 'item' : 'items'} ]`;
	}
	if (value && typeof value === 'object') {
		const keys = Object.keys(value);
		const n = keys.length;
		return `{ … ${n} ${n === 1 ? 'key' : 'keys'} }`;
	}
	return '';
}

function Tree({ value, depth, keyName, isLast, path, overrides, setOverrides }) {
	const t = valueType(value);
	const indent = ' '.repeat(depth * INDENT);

	// Scalars render inline.
	if (t !== 'object' && t !== 'array') {
		return (
			<div className="trb-line">
				<span className="trb-indent">{indent}</span>
				{keyName !== undefined && (
					<>
						<span className="trb-key">&quot;{keyName}&quot;</span>
						<span className="trb-punct">: </span>
					</>
				)}
				<ScalarToken value={value} />
				{!isLast && <span className="trb-punct">,</span>}
			</div>
		);
	}

	// Empty containers render inline too — no value in showing a
	// chevron just to expand an empty object.
	const entries = t === 'array' ? value.map((v, i) => [i, v]) : Object.entries(value);
	if (entries.length === 0) {
		return (
			<div className="trb-line">
				<span className="trb-indent">{indent}</span>
				{keyName !== undefined && (
					<>
						<span className="trb-key">&quot;{keyName}&quot;</span>
						<span className="trb-punct">: </span>
					</>
				)}
				<span className="trb-punct">{t === 'array' ? '[]' : '{}'}</span>
				{!isLast && <span className="trb-punct">,</span>}
			</div>
		);
	}

	// Open/closed is the union of (default by depth) + (per-path
	// override from expand-all / collapse-all / per-row click). Path
	// is keyed off position-from-root so it survives expand/collapse
	// cycles on the same data.
	const override = overrides.get(path);
	const open = override === undefined ? depth < DEFAULT_OPEN_DEPTH : override;
	const indentStr = indent;
	const openBracket = t === 'array' ? '[' : '{';
	const closeBracket = t === 'array' ? ']' : '}';

	const toggle = () => {
		const next = new Map(overrides);
		next.set(path, !open);
		setOverrides(next);
	};

	return (
		<>
			<div className="trb-line trb-line--clickable" onClick={toggle}>
				<span className="trb-indent">{indentStr}</span>
				<span className="trb-toggle">
					{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
				</span>
				{keyName !== undefined && (
					<>
						<span className="trb-key">&quot;{keyName}&quot;</span>
						<span className="trb-punct">: </span>
					</>
				)}
				<span className="trb-punct">{openBracket}</span>
				{!open && (
					<>
						{' '}
						<span className="trb-preview">{previewSummary(value)}</span>{' '}
						<span className="trb-punct">{closeBracket}</span>
						{!isLast && <span className="trb-punct">,</span>}
					</>
				)}
			</div>
			{open && (
				<>
					{entries.map(([k, v], i) => (
						<Tree
							key={t === 'array' ? `i-${k}` : `k-${k}`}
							value={v}
							depth={depth + 1}
							keyName={t === 'array' ? undefined : k}
							isLast={i === entries.length - 1}
							path={`${path}.${k}`}
							overrides={overrides}
							setOverrides={setOverrides}
						/>
					))}
					<div className="trb-line">
						<span className="trb-indent">{indentStr}</span>
						<span className="trb-punct">{closeBracket}</span>
						{!isLast && <span className="trb-punct">,</span>}
					</div>
				</>
			)}
		</>
	);
}

/**
 * Render an EdgeLake response body. Attempts JSON parsing; on success
 * renders a colorized, collapsible tree. On failure renders the raw
 * text verbatim in a <pre> — every existing behavior preserved.
 *
 * Props:
 *   - body: string                — the raw response text
 *   - placeholder: bool          — when true, render as italic helper text
 *                                   (caller uses this for empty 200 + similar)
 *   - error: bool                — when true, render in the error color
 */
export default function TerminalResponseBody({ body, placeholder = false, error = false }) {
	const parsed = useMemo(() => tryParseJSON(body), [body]);

	// Per-path open/closed overrides. Empty map → use default-by-depth
	// rule. Expand-all writes `true` for every container path; collapse-
	// all writes `false`. Per-row clicks flip a single path.
	const [overrides, setOverrides] = useState(() => new Map());

	const allContainerPaths = useMemo(() => {
		if (!parsed.ok) return [];
		const t = valueType(parsed.value);
		if (t !== 'object' && t !== 'array') return [];
		return collectContainerPaths(parsed.value);
	}, [parsed]);

	// Resolve the current open-state for a container path. Mirrors the
	// rule used inside <Tree>: explicit override wins, otherwise the
	// depth default. Used by the step-buttons to inspect the tree's
	// current shape without rendering it.
	const isOpenAt = (path, depth) => {
		if (overrides.has(path)) return overrides.get(path);
		return depth < DEFAULT_OPEN_DEPTH;
	};

	const expandAll = () => {
		const next = new Map();
		for (const { path } of allContainerPaths) next.set(path, true);
		setOverrides(next);
	};

	const collapseAll = () => {
		const next = new Map();
		// "Collapse all" means: top-level open (so the user can see
		// SOMETHING is there) but every nested container closed. iTerm
		// JSON viewers all behave this way — a fully-collapsed root is
		// indistinguishable from no data.
		for (const { path } of allContainerPaths) {
			next.set(path, path === '$');
		}
		setOverrides(next);
	};

	// Expand the shallowest currently-closed layer of the tree by one
	// level. We find the minimum depth among closed containers and open
	// every container at that depth. If everything is already open, this
	// is a no-op. Acting on the whole layer at once (rather than a
	// single node) means a `blockchain get *` payload opens uniformly —
	// one click reveals every operator's fields, not just the first.
	const expandOneLevel = () => {
		let minClosedDepth = Infinity;
		for (const { path, depth } of allContainerPaths) {
			if (!isOpenAt(path, depth) && depth < minClosedDepth) {
				minClosedDepth = depth;
			}
		}
		if (!Number.isFinite(minClosedDepth)) return;
		const next = new Map(overrides);
		for (const { path, depth } of allContainerPaths) {
			if (depth === minClosedDepth) next.set(path, true);
		}
		setOverrides(next);
	};

	// Mirror of expandOneLevel for collapse: close the deepest currently-
	// open layer. Top-level stays open (same rule as collapseAll) so the
	// user always sees the root brackets.
	const collapseOneLevel = () => {
		let maxOpenDepth = -1;
		for (const { path, depth } of allContainerPaths) {
			if (depth > 0 && isOpenAt(path, depth) && depth > maxOpenDepth) {
				maxOpenDepth = depth;
			}
		}
		if (maxOpenDepth < 0) return;
		const next = new Map(overrides);
		for (const { path, depth } of allContainerPaths) {
			if (depth === maxOpenDepth) next.set(path, false);
		}
		setOverrides(next);
	};

	const resetToDefault = () => setOverrides(new Map());

	if (placeholder) {
		return <pre className="trb-plain trb-plain--placeholder">{body}</pre>;
	}
	if (error) {
		return <pre className="trb-plain trb-plain--error">{body}</pre>;
	}
	if (!parsed.ok) {
		return <pre className="trb-plain">{body}</pre>;
	}

	const t = valueType(parsed.value);

	if (t !== 'object' && t !== 'array') {
		// Top-level scalar (a JSON string or number response). Render
		// the parsed value inline; the type colors still apply. No
		// expand/collapse affordance — nothing to expand.
		return (
			<pre className="trb-json">
				<ScalarToken value={parsed.value} />
			</pre>
		);
	}

	// Only show the expand-all / collapse-all controls when there's
	// more than one container (i.e. at least one nested object/array).
	// Single-container payloads are trivially toggled via the chevron.
	const showBulkControls = allContainerPaths.length > 1;

	return (
		<div className="trb-json-wrap">
			{showBulkControls && (
				<div className="trb-json-actions">
					<IconButton
						kind="ghost"
						size="sm"
						label="Collapse all"
						onClick={collapseAll}
					>
						<CollapseAll />
					</IconButton>
					<IconButton
						kind="ghost"
						size="sm"
						label="Collapse one level"
						onClick={collapseOneLevel}
					>
						<ChevronUp />
					</IconButton>
					<IconButton
						kind="ghost"
						size="sm"
						label="Expand one level"
						onClick={expandOneLevel}
					>
						<ChevronDown />
					</IconButton>
					<IconButton
						kind="ghost"
						size="sm"
						label="Expand all"
						onClick={expandAll}
					>
						<ExpandAll />
					</IconButton>
					<IconButton
						kind="ghost"
						size="sm"
						label="Reset to default view"
						onClick={resetToDefault}
					>
						<Reset />
					</IconButton>
				</div>
			)}
			<pre className="trb-json">
				<Tree
					value={parsed.value}
					depth={0}
					keyName={undefined}
					isLast
					path="$"
					overrides={overrides}
					setOverrides={setOverrides}
				/>
			</pre>
		</div>
	);
}
