#!/usr/bin/env node
// Vendors the pure protocol modules of technocore-watch-core into this package.
//
// n8n community nodes may not have runtime dependencies and `n8n-node build` is plain tsc,
// so the node cannot import the core package: the pure, I/O-free protocol code is copied
// in verbatim (plus a provenance banner) and pinned by integrity hashes in VENDOR.json.
//
//   node scripts/vendor-core.mjs          copy src/protocol/*.ts from the core repo's git HEAD
//   node scripts/vendor-core.mjs --check  fail when a vendored file no longer matches VENDOR.json,
//                                         or (when the core checkout is present) when the core's
//                                         HEAD has moved on from what was vendored
//
// Source: $TECHNOCORE_WATCH_CORE, else ../technocore-watch-core next to this repo. Files are
// read from the committed HEAD (never a half-edited working tree).
//
// The banner is a provenance line, plus (only for files listed in LINT_EXCEPTIONS) a scoped
// eslint-disable: parse.ts is pure protocol code that throws its own ProtocolError, which
// every call site in this package converts to NodeOperationError. Nothing else is changed.
// Integrity values use the SRI form (sha256-<base64>) so no 64-hex strings are committed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEST = path.join(ROOT, 'nodes', 'Technocore', 'shared', 'protocol');
const VENDOR_FILE = path.join(DEST, 'VENDOR.json');
const CORE_ROOT = process.env.TECHNOCORE_WATCH_CORE
	? path.resolve(process.env.TECHNOCORE_WATCH_CORE)
	: path.resolve(ROOT, '..', 'technocore-watch-core');
const SOURCE_DIR = 'src/protocol';

export function integrity(content) {
	return `sha256-${createHash('sha256').update(content).digest('base64')}`;
}

// Files whose upstream code trips a community-node lint rule that does not apply to pure
// protocol code. Kept explicit: a new exception must be added here deliberately.
export const LINT_EXCEPTIONS = {
	'parse.ts': [
		'@n8n/community-nodes/require-node-api-error -- pure protocol code throws ProtocolError; call sites map it to NodeOperationError',
	],
};

export function banner(commit, name) {
	const disables = (LINT_EXCEPTIONS[name] ?? []).map((rule) => `/* eslint-disable ${rule} */\n`).join('');
	return `// VENDORED from technocore-watch-core@${commit} ${SOURCE_DIR}/${name} - do not edit; run \`npm run vendor\`.\n${disables}`;
}

function git(args) {
	return execFileSync('git', args, { cwd: CORE_ROOT, maxBuffer: 64 * 1024 * 1024 });
}

function coreAvailable() {
	if (!existsSync(path.join(CORE_ROOT, '.git'))) return false;
	try {
		git(['rev-parse', '--verify', 'HEAD']);
		return true;
	} catch {
		return false;
	}
}

function sourceFiles() {
	return git(['ls-tree', '--name-only', 'HEAD', `${SOURCE_DIR}/`])
		.toString('utf8')
		.split('\n')
		.filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.spec.ts'))
		.map((p) => path.posix.basename(p))
		.sort();
}

function vendoredFiles() {
	return readdirSync(DEST)
		.filter((name) => name.endsWith('.ts'))
		.sort();
}

export function check() {
	const errors = [];
	const warnings = [];
	if (!existsSync(VENDOR_FILE)) return { errors: ['VENDOR.json is missing'], warnings };
	const record = JSON.parse(readFileSync(VENDOR_FILE, 'utf8'));
	const present = vendoredFiles();
	const listed = Object.keys(record.files ?? {}).sort();
	for (const name of present) if (!listed.includes(name)) errors.push(`${name} is not listed in VENDOR.json`);
	for (const name of listed) {
		if (!present.includes(name)) {
			errors.push(`${name} is listed in VENDOR.json but missing`);
			continue;
		}
		const content = readFileSync(path.join(DEST, name));
		if (integrity(content) !== record.files[name].vendored) {
			errors.push(`${name} was edited after vendoring (integrity mismatch)`);
		}
		const expectedBanner = banner(record.commit, name);
		if (!content.toString('utf8').startsWith(expectedBanner)) errors.push(`${name} lost its vendoring banner`);
	}
	const drift = [];
	if (coreAvailable()) {
		const head = git(['rev-parse', 'HEAD']).toString().trim();
		if (head !== record.commit) {
			for (const name of sourceFiles()) {
				const upstream = git(['show', `HEAD:${SOURCE_DIR}/${name}`]);
				if (record.files?.[name]?.source !== integrity(upstream)) drift.push(name);
			}
			for (const name of listed) if (!sourceFiles().includes(name)) drift.push(name);
			if (drift.length) {
				warnings.push(
					`technocore-watch-core HEAD ${head.slice(0, 7)} differs from vendored ${String(record.commit).slice(0, 7)} in: ${drift.join(', ')}. Run npm run vendor.`,
				);
			}
		}
	}
	return { errors, warnings, drift, record };
}

function vendor() {
	if (!coreAvailable()) {
		console.error(`vendor-core: no git checkout of technocore-watch-core at ${CORE_ROOT}`);
		process.exit(1);
	}
	const commit = git(['rev-parse', 'HEAD']).toString().trim();
	let version;
	try {
		version = JSON.parse(git(['show', 'HEAD:package.json']).toString('utf8')).version;
	} catch {
		version = undefined;
	}
	const names = sourceFiles();
	for (const stale of vendoredFiles()) if (!names.includes(stale)) unlinkSync(path.join(DEST, stale));
	const files = {};
	for (const name of names) {
		const upstream = git(['show', `HEAD:${SOURCE_DIR}/${name}`]);
		const vendored = Buffer.concat([Buffer.from(banner(commit, name), 'utf8'), upstream]);
		writeFileSync(path.join(DEST, name), vendored);
		files[name] = { source: integrity(upstream), vendored: integrity(vendored) };
	}
	const record = {
		source: `technocore-watch-core/${SOURCE_DIR}`,
		version,
		commit,
		transform: 'banner prepended (provenance line; scoped eslint-disable for files in LINT_EXCEPTIONS); upstream bytes otherwise unchanged',
		files,
	};
	writeFileSync(VENDOR_FILE, `${JSON.stringify(record, null, '\t')}\n`);
	console.log(`vendor-core: vendored ${names.length} file(s) from technocore-watch-core@${commit.slice(0, 7)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes('--check')) {
		const { errors, warnings, drift } = check();
		for (const w of warnings) console.warn(`vendor-core: warning: ${w}`);
		for (const e of errors) console.error(`vendor-core: ${e}`);
		if (errors.length || (drift && drift.length)) process.exit(1);
		console.log('vendor-core: vendored protocol files match VENDOR.json');
	} else {
		vendor();
	}
}
