#!/usr/bin/env node
// Runs the same two ESLint legs as `npx @n8n/scan-community-package` (the n8n verification
// scanner) without needing a published package:
//   source leg: the committed sources (git HEAD), patterns package.json + {nodes,credentials}/**
//   dist leg:   the `npm pack` tarball, patterns **/*.js + package.json
// Like the real scanner it ignores inline eslint-disable comments. The provenance and
// source-download steps of the real scanner need a published package and are not covered.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	SOURCE_FILE_PATTERNS,
	analyzePackage,
} from '@n8n/scan-community-package/scanner/scanner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function scanLocal() {
	const work = mkdtempSync(path.join(os.tmpdir(), 'n8n-scan-'));
	try {
		const source = path.join(work, 'source');
		const archive = execFileSync('git', ['archive', '--format=tar', `--prefix=source/`, 'HEAD'], {
			cwd: ROOT,
			maxBuffer: 256 * 1024 * 1024,
		});
		execFileSync('tar', ['-x', '-C', work], { input: archive });
		const packDir = path.join(work, 'pack');
		execFileSync('npm', ['pack', '--pack-destination', work], { cwd: ROOT, stdio: 'pipe' });
		const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
		execFileSync('mkdir', ['-p', packDir]);
		execFileSync('tar', ['-xzf', path.join(work, tarball), '-C', packDir, '--strip-components=1']);
		const sourceResult = await analyzePackage(source, SOURCE_FILE_PATTERNS);
		const distResult = await analyzePackage(packDir, ['**/*.js', 'package.json']);
		return { sourceResult, distResult, passed: sourceResult.passed && distResult.passed };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { sourceResult, distResult, passed } = await scanLocal();
	for (const [leg, result] of [
		['source', sourceResult],
		['dist', distResult],
	]) {
		console.log(`${leg}: ${result.passed ? 'passed' : `FAILED (${result.message})`}`);
		if (result.details) console.log(result.details);
	}
	process.exit(passed ? 0 : 1);
}
