// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.
//
// Standalone smoke-test for searchQuery.js. The client project doesn't
// have a configured test framework, so this is a plain node script —
// `node client/src/components/snippets/searchQuery.test.mjs` exits
// non-zero on any failure. Bare-minimum assert harness.
//
// When the project adopts vitest or jest, convert each `t(...)` call
// to a real test case.

import parseSnippetQuery from './searchQuery.js';

let failed = 0;

const fixtures = [
	{ title: 'GET STATUS', command: 'get status', tags: ['Investigation'] },
	{ title: 'TEST NETWORK', command: 'test network', tags: ['Network'] },
	{ title: 'BLOCKCHAIN GET OP', command: 'blockchain get table where type=operator', tags: ['Network'] },
	{ title: 'SET DEBUG ON', command: 'set debug on', tags: ['Debug'] },
	{ title: 'mel logs query', command: 'mel logs query', tags: [] },
];

function ids(items) {
	return items.map((i) => i.title);
}

function expectMatch(query, expected) {
	const pred = parseSnippetQuery(query);
	const got = ids(fixtures.filter(pred));
	const ok =
		got.length === expected.length && got.every((t) => expected.includes(t));
	if (!ok) {
		failed += 1;
		console.error(`FAIL  query=${JSON.stringify(query)}`);
		console.error(`        got     = ${JSON.stringify(got)}`);
		console.error(`        wanted  = ${JSON.stringify(expected)}`);
	} else {
		console.log(`pass  query=${JSON.stringify(query)} → ${JSON.stringify(got)}`);
	}
}

// Empty / whitespace
expectMatch('', ['GET STATUS', 'TEST NETWORK', 'BLOCKCHAIN GET OP', 'SET DEBUG ON', 'mel logs query']);
expectMatch('   ', ['GET STATUS', 'TEST NETWORK', 'BLOCKCHAIN GET OP', 'SET DEBUG ON', 'mel logs query']);

// Plain term: case-insensitive, matches across all fields
expectMatch('get', ['GET STATUS', 'BLOCKCHAIN GET OP']);
expectMatch('GET', ['GET STATUS', 'BLOCKCHAIN GET OP']);
expectMatch('network', ['TEST NETWORK', 'BLOCKCHAIN GET OP']); // tag and title hits

// Field-qualified
expectMatch('title:get', ['GET STATUS', 'BLOCKCHAIN GET OP']);
expectMatch('text:operator', ['BLOCKCHAIN GET OP']);
expectMatch('tag:network', ['TEST NETWORK', 'BLOCKCHAIN GET OP']);
expectMatch('tag:debug', ['SET DEBUG ON']);

// Negation
expectMatch('-network', ['GET STATUS', 'SET DEBUG ON', 'mel logs query']);
expectMatch('-tag:network', ['GET STATUS', 'SET DEBUG ON', 'mel logs query']);

// Implicit AND between whitespace-separated tokens
expectMatch('get tag:network', ['BLOCKCHAIN GET OP']);
expectMatch('get -tag:network', ['GET STATUS']);

// OR with |
expectMatch('debug|operator', ['BLOCKCHAIN GET OP', 'SET DEBUG ON']);
expectMatch('tag:debug|tag:network', ['TEST NETWORK', 'BLOCKCHAIN GET OP', 'SET DEBUG ON']);

// Combined: (tag:debug OR tag:network) AND get
expectMatch('tag:debug|tag:network get', ['BLOCKCHAIN GET OP']);

if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log('\nall good');
