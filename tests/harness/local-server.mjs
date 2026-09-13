// Disposable LOCAL Technocore server for integration tests (never production).
// Spawns `uv run uvicorn --app-dir src app:app` from the technocore-chat checkout with a
// temporary CHAT_ROOT and test knobs, waits for /healthz, and kills the process group on stop.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { checkoutPath } from './python.mjs';

function portIsFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
	});
}

async function pickPort() {
	for (let attempt = 0; attempt < 50; attempt++) {
		const port = 20000 + Math.floor(Math.random() * 40000);
		if (await portIsFree(port)) return port;
	}
	throw new Error('no free port found in 20000-60000');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ env?: Record<string,string>, root?: string, port?: number }} [options]
 * @returns {Promise<{ origin: string, root: string, port: number, stop: () => Promise<void> }>}
 */
export async function startTechnocore(options = {}) {
	const checkout = checkoutPath();
	const root = options.root ?? mkdtempSync(path.join(os.tmpdir(), 'tc-n8n-root-'));
	const port = options.port ?? (await pickPort());
	const env = {
		...process.env,
		CHAT_ROOT: root,
		CHAT_RATE_READ: '1000000',
		CHAT_RATE_WRITE: '1000000',
		CHAT_RATE_ROOMS_PER_DAY: '1000000',
		CHAT_DUPE_FILTER_SECONDS: '0',
		CHAT_EDGE_CACHE_SECONDS: '0',
		CHAT_FSYNC: '0',
		...(options.env ?? {}),
	};
	const child = spawn(
		'uv',
		[
			'run',
			'uvicorn',
			'--app-dir',
			'src',
			'app:app',
			'--host',
			'127.0.0.1',
			'--port',
			String(port),
		],
		{ cwd: checkout, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
	);
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk.toString()).slice(-4000);
	});
	let exited = false;
	child.once('exit', () => {
		exited = true;
	});
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (exited) throw new Error(`technocore server exited during startup: ${stderr}`);
		try {
			const response = await fetch(`${origin}/healthz`);
			if (response.status === 200) break;
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) {
			process.kill(-child.pid, 'SIGKILL');
			throw new Error(`technocore server did not become healthy: ${stderr}`);
		}
		await sleep(200);
	}
	const stop = async () => {
		if (!exited) {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				// already gone
			}
			const until = Date.now() + 10_000;
			while (!exited && Date.now() < until) await sleep(100);
			if (!exited) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					// already gone
				}
			}
		}
		if (!options.root) rmSync(root, { recursive: true, force: true });
	};
	return { origin, root, port, stop };
}

/** Unsigned JSON post straight to the local server (test writer, not the node under test). */
export async function postUnsigned(origin, room, from, text) {
	const response = await fetch(`${origin}/r/${room}?format=json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ from, text }),
	});
	if (response.status !== 200)
		throw new Error(`post failed ${response.status}: ${await response.text()}`);
	return response;
}

/**
 * Runs Python against a STOPPED local server's CHAT_ROOT with the server's own store module,
 * to simulate what the service does to rooms over time (reap, recreation). `code` sees
 * `store`, `root` (a pathlib.Path) and `room`.
 */
export function mutateStore(root, room, code) {
	const script = [
		'import pathlib, sys',
		"sys.path.insert(0, 'src')",
		'import store',
		`root = pathlib.Path(${JSON.stringify(root)})`,
		`room = ${JSON.stringify(room)}`,
		code,
	].join('\n');
	const result = spawnSync('uv', ['run', 'python', '-c', script], {
		cwd: checkoutPath(),
		env: { ...process.env, CHAT_ROOT: root },
		encoding: 'utf8',
	});
	if (result.status !== 0) throw new Error(`store mutation failed: ${result.stderr}`);
	return result.stdout;
}

/** A temporary CHAT_ROOT that survives server restarts; remove it with removeRoot(). */
export function makeRoot() {
	return mkdtempSync(path.join(os.tmpdir(), 'tc-n8n-root-'));
}

export function removeRoot(root) {
	rmSync(root, { recursive: true, force: true });
}
