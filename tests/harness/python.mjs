// Cross-check helpers: run the upstream Python signer and the server's own sweep.
// Plain .mjs on purpose: test tooling needs child_process and process, which the n8n
// community-node lint rules (rightly) forbid in node code; these files never ship.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** technocore-chat checkout: $TECHNOCORE_CHECKOUT, else ../.cache/technocore-chat beside this repo. */
export function checkoutPath() {
	return process.env.TECHNOCORE_CHECKOUT
		? path.resolve(process.env.TECHNOCORE_CHECKOUT)
		: path.resolve(PACKAGE_ROOT, '..', '.cache', 'technocore-chat');
}

export function hasCheckout() {
	const root = checkoutPath();
	return existsSync(path.join(root, 'scripts', 'sign.py')) && existsSync(path.join(root, 'src', 'store.py'));
}

function uv(args, { cwd, input, env } = {}) {
	const result = spawnSync('uv', args, {
		cwd,
		input,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`uv ${args.slice(0, 3).join(' ')} failed (${result.status}): ${result.stderr.slice(0, 2000)}`);
	}
	return result.stdout;
}

/**
 * `uv run scripts/sign.py --seed <TEST seed> <args...>` exactly as documented upstream.
 * Only public TEST seeds are ever passed here.
 */
export function signPy(seedHex, args) {
	const root = checkoutPath();
	return uv(['run', path.join(root, 'scripts', 'sign.py'), '--seed', seedHex, ...args], { cwd: root })
		.split('\n')
		.filter(Boolean);
}

/** Batch requests to tests/harness/crosscheck.py, run inside the server's own venv. */
export function pythonBatch(request) {
	const root = checkoutPath();
	const out = uv(['run', 'python', path.join(PACKAGE_ROOT, 'tests', 'harness', 'crosscheck.py')], {
		cwd: root,
		input: JSON.stringify(request),
		env: { TECHNOCORE_CHECKOUT: root },
	});
	return JSON.parse(out);
}

/** Regenerates the sweep table with the server's Python; returns the TS source. */
export function generateSweepTable() {
	const root = checkoutPath();
	return uv(['run', 'python', path.join(PACKAGE_ROOT, 'scripts', 'gen-sweep-table.py')], { cwd: root });
}
