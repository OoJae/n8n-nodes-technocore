#!/usr/bin/env node
// Refuses any file that contains a run of 64+ hexadecimal characters (the shape of an
// Ed25519 seed or any other 32-byte secret written as hex) unless the exact value is an
// explicitly allow-listed, public TEST vector in .secret-scan-allow.json.
//
//   node scripts/secret-scan.mjs            scan every tracked file (CI, tests)
//   node scripts/secret-scan.mjs --staged   scan the staged content (pre-commit hook)
//
// Never prints a matched value: only the file, line and a short prefix.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_FILE = '.secret-scan-allow.json';
const HEX_RUN = /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;

function git(args, options = {}) {
	return execFileSync('git', args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, ...options });
}

export function loadAllowList(root = ROOT) {
	const raw = JSON.parse(readFileSync(path.join(root, ALLOW_FILE), 'utf8'));
	const allowed = new Map();
	for (const entry of raw.allow ?? []) {
		if (
			typeof entry.value !== 'string' ||
			typeof entry.label !== 'string' ||
			!/test/i.test(entry.label)
		) {
			throw new Error(
				`${ALLOW_FILE}: every entry needs a value and a label that says it is a test vector`,
			);
		}
		allowed.set(entry.value.toLowerCase(), entry.label);
	}
	return allowed;
}

export function findHexSecrets(text, allowed) {
	const findings = [];
	const lines = text.split('\n');
	lines.forEach((line, index) => {
		for (const match of line.matchAll(HEX_RUN)) {
			if (!allowed.has(match[0].toLowerCase())) {
				findings.push({
					line: index + 1,
					prefix: `${match[0].slice(0, 6)}...`,
					length: match[0].length,
				});
			}
		}
	});
	return findings;
}

function isProbablyBinary(buffer) {
	return buffer.subarray(0, 8000).includes(0);
}

export function scan({ staged = false, root = ROOT } = {}) {
	const allowed = loadAllowList(root);
	const files = staged
		? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
				.toString('utf8')
				.split('\0')
				.filter(Boolean)
		: git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
	const problems = [];
	for (const file of files) {
		let content;
		try {
			content = staged ? git(['show', `:${file}`]) : readFileSync(path.join(root, file));
		} catch {
			continue; // deleted in the working tree but still tracked
		}
		if (isProbablyBinary(content)) continue;
		for (const finding of findHexSecrets(content.toString('utf8'), allowed)) {
			problems.push({ file, ...finding });
		}
	}
	return { files: files.length, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { files, problems } = scan({ staged: process.argv.includes('--staged') });
	if (problems.length) {
		console.error(
			'secret-scan: refusing hex strings of 64+ characters that are not allow-listed test vectors:',
		);
		for (const p of problems)
			console.error(`  ${p.file}:${p.line}  ${p.prefix} (${p.length} hex chars)`);
		console.error(
			`If one is a public TEST vector, add it to ${ALLOW_FILE} with a label containing "test".`,
		);
		process.exit(1);
	}
	console.log(`secret-scan: ${files} file(s) clean`);
}
