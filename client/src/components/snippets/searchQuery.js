// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pure parser for the snippets-panel search box. Modeled on iTerm2's
// snippets search syntax so muscle-memory copy-paste works:
//
//   linux             matches across title/command/tags
//   title:foo         matches only the title
//   text:foo          matches only the command
//   tag:foo           matches only tags
//   -linux            excludes snippets containing "linux"
//   -tag:linux        excludes snippets tagged "linux"
//   linux|bsd         matches "linux" OR "bsd" (binds tighter than AND)
//   tag:a|tag:b ssh   = (tag:a OR tag:b) AND ssh
//
// Returns a (snippet) → boolean predicate. An empty / whitespace-only
// query returns a predicate that matches everything.

const FIELD_PREFIXES = ['title:', 'text:', 'tag:'];

function tokenize(input) {
	// Split on whitespace, preserving the order. We don't need to
	// handle quoted strings — the grammar is intentionally tiny.
	return String(input ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

function parseAtom(rawAtom) {
	let atom = rawAtom;
	let negated = false;
	if (atom.startsWith('-')) {
		negated = true;
		atom = atom.slice(1);
	}
	if (!atom) return null;

	let field = null;
	let needle = atom;
	for (const prefix of FIELD_PREFIXES) {
		if (atom.toLowerCase().startsWith(prefix)) {
			field = prefix.slice(0, -1); // strip the colon
			needle = atom.slice(prefix.length);
			break;
		}
	}
	if (!needle) return null;

	return { field, needle: needle.toLowerCase(), negated };
}

function atomMatches(atom, snippet) {
	const title = String(snippet?.title ?? '').toLowerCase();
	const command = String(snippet?.command ?? '').toLowerCase();
	const tags = Array.isArray(snippet?.tags)
		? snippet.tags.map((t) => String(t).toLowerCase())
		: [];

	const found = (() => {
		switch (atom.field) {
			case 'title':
				return title.includes(atom.needle);
			case 'text':
				return command.includes(atom.needle);
			case 'tag':
				return tags.some((t) => t.includes(atom.needle));
			default:
				return (
					title.includes(atom.needle) ||
					command.includes(atom.needle) ||
					tags.some((t) => t.includes(atom.needle))
				);
		}
	})();

	return atom.negated ? !found : found;
}

function tokenMatches(rawToken, snippet) {
	// `|` is logical OR. It binds tighter than the implicit AND between
	// whitespace-separated tokens, so we parse each whitespace token
	// independently into a list of OR-alternatives.
	const alternatives = rawToken
		.split('|')
		.map(parseAtom)
		.filter(Boolean);

	if (alternatives.length === 0) return true;
	return alternatives.some((atom) => atomMatches(atom, snippet));
}

/**
 * Build a snippet-matcher function from a query string. The returned
 * function is `(snippet) => boolean`.
 */
export default function parseSnippetQuery(input) {
	const tokens = tokenize(input);
	if (tokens.length === 0) return () => true;
	return (snippet) => tokens.every((tok) => tokenMatches(tok, snippet));
}
