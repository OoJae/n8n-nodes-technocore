#!/usr/bin/env node
// Refuses any file that contains a run of 64+ hexadecimal characters (the shape of an
// Ed25519 seed or any other 32-byte secret written as hex) unless the exact value is an
// explicitly allow-listed, public TEST vector in .secret-scan-allow.json, and any file that
// contains an email address other than the one entry in ALLOWED_EMAILS: the user-approved
// GitHub noreply author address (n8n's valid-author rule needs an author email). The match is
// exact and case-sensitive; any other address, including another user's GitHub noreply address,
// is refused. A URL's `user:password@host` part is not an email address and is not flagged.
//
//   node scripts/secret-scan.mjs            scan every tracked file (CI, tests)
//   node scripts/secret-scan.mjs --staged   scan the staged content (pre-commit hook)
//
// Every file is scanned, text or binary: as UTF-8 (which keeps ASCII runs inside binary
// data), and, when it holds NUL bytes, also as UTF-16 in both byte orders, so a seed saved
// by a tool that writes UTF-16 (a PowerShell redirect, an editor's "Unicode") is found too.
//
// Never prints a matched value: only the file, line and a short prefix (hex) or nothing
// (email).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_FILE = '.secret-scan-allow.json';
const HEX_RUN = /(?<![0-9a-fA-F])[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g;
// An address (local part, "@", dotted domain), not preceded by another local-part character and not the userinfo of a
// `scheme://user:password@host` URL. Package specs such as `n8n@2.38.7` or `npm@latest` have
// no alphabetic top-level domain and do not match.
const EMAIL =
	/(?<![A-Za-z0-9._%+-])(?<!:\/\/[^\s/@]*)[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

/**
 * The only email addresses the scan accepts, compared exactly against the whole matched address.
 * Deliberately a constant in code, not a data file: widening it is a code change under review.
 */
export const ALLOWED_EMAILS = Object.freeze([
	Object.freeze({
		value: '73647277+OoJae@users.noreply.github.com',
		label: 'GitHub noreply author (user-approved)',
	}),
]);
const ALLOWED_EMAIL_VALUES = new Set(ALLOWED_EMAILS.map((entry) => entry.value));

function git(args, root = ROOT) {
	return execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
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

/**
 * Findings in raw file content. UTF-16 code units for ASCII hex digits always contain a NUL
 * byte, so the UTF-16 decodings (little-endian at offset 0, big-endian as little-endian at
 * offset 1) are only needed, and only tried, when the content has one.
 */
export function findHexSecretsInBuffer(buffer, allowed) {
	return findInDecodings(buffer, (text) => findHexSecrets(text, allowed));
}

/**
 * Email addresses in text, by line, except an exact ALLOWED_EMAILS address. The address itself
 * is never returned.
 */
export function findEmails(text) {
	const findings = [];
	text.split('\n').forEach((line, index) => {
		for (const match of line.matchAll(EMAIL)) {
			if (!ALLOWED_EMAIL_VALUES.has(match[0])) findings.push({ line: index + 1, kind: 'email' });
		}
	});
	return findings;
}

/** Email addresses in raw file content, decoded the same ways as findHexSecretsInBuffer. */
export function findEmailsInBuffer(buffer) {
	return findInDecodings(buffer, findEmails);
}

function findInDecodings(buffer, find) {
	const texts = [{ encoding: 'utf-8', text: buffer.toString('utf8') }];
	if (buffer.includes(0)) {
		texts.push({ encoding: 'utf-16le', text: buffer.toString('utf16le') });
		texts.push({ encoding: 'utf-16be', text: buffer.subarray(1).toString('utf16le') });
	}
	const findings = [];
	for (const { encoding, text } of texts) {
		for (const finding of find(text)) {
			findings.push(encoding === 'utf-8' ? finding : { ...finding, encoding });
		}
	}
	return findings;
}

export function scan({ staged = false, root = ROOT } = {}) {
	const allowed = loadAllowList(root);
	const files = staged
		? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root)
				.toString('utf8')
				.split('\0')
				.filter(Boolean)
		: git(['ls-files', '-z'], root).toString('utf8').split('\0').filter(Boolean);
	const problems = [];
	for (const file of files) {
		let content;
		try {
			content = staged ? git(['show', `:${file}`], root) : readFileSync(path.join(root, file));
		} catch {
			continue; // deleted in the working tree but still tracked
		}
		for (const finding of findHexSecretsInBuffer(content, allowed)) {
			problems.push({ file, ...finding });
		}
		for (const finding of findEmailsInBuffer(content)) {
			problems.push({ file, ...finding });
		}
	}
	return { files: files.length, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { files, problems } = scan({ staged: process.argv.includes('--staged') });
	if (problems.length) {
		console.error(
			'secret-scan: refusing email addresses (other than the allowed GitHub noreply author), and hex strings of 64+ characters that are not allow-listed test vectors:',
		);
		for (const p of problems) {
			const encoding = p.encoding ? `, ${p.encoding}` : '';
			console.error(
				p.kind === 'email'
					? `  ${p.file}:${p.line}  email address${encoding ? ` (${p.encoding})` : ''}`
					: `  ${p.file}:${p.line}  ${p.prefix} (${p.length} hex chars${encoding})`,
			);
		}
		console.error(
			`If a hex string is a public TEST vector, add it to ${ALLOW_FILE} with a label containing "test". Remove email addresses; the only allowed one is ${ALLOWED_EMAILS.map((e) => e.label).join(', ')}.`,
		);
		process.exit(1);
	}
	console.log(`secret-scan: ${files} file(s) clean`);
}
