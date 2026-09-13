// A disposable, real n8n instance for end-to-end tests (never shipped).
//
// The package is installed the way Settings -> Community Nodes installs it: `npm pack` of
// this repo, unpacked into <user folder>/.n8n/nodes/node_modules/n8n-nodes-technocore, where
// n8n's community-package loader (PackageDirectoryLoader) picks it up. That matters: the
// `restrictToSupportedNodes` list is only resolved for package loaders, so a custom-folder
// load (what `n8n-node dev` does) cannot use the signing credential at all.
//
// n8n itself must be installed separately, on a Node.js release n8n supports (n8n 2.x needs
// Node 24; its isolated-vm module does not build on Node 26):
//   N8N_E2E_NODE     path to that node binary
//   N8N_E2E_N8N_BIN  path to n8n's bin/n8n script (e.g. <dir>/node_modules/n8n/bin/n8n)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { PACKAGE_ROOT } from './python.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function n8nInstall() {
	const node = process.env.N8N_E2E_NODE;
	const bin = process.env.N8N_E2E_N8N_BIN;
	if (!node || !bin || !existsSync(node) || !existsSync(bin)) {
		throw new Error(
			'the real-n8n e2e test needs N8N_E2E_NODE (a Node.js 24 binary) and N8N_E2E_N8N_BIN (n8n/bin/n8n of an n8n install); see README, Development',
		);
	}
	const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim();
	const n8nVersion = JSON.parse(
		execFileSync(
			node,
			[
				'-p',
				`JSON.stringify(require(${JSON.stringify(path.join(path.dirname(bin), '..', 'package.json'))}).version)`,
			],
			{
				encoding: 'utf8',
			},
		),
	);
	return { node, bin, nodeVersion: version, n8nVersion };
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Builds and packs this repo, then installs the tarball as a community package. */
function installPackage(userFolder) {
	const work = mkdtempSync(path.join(os.tmpdir(), 'tc-n8n-pack-'));
	try {
		const out = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
			cwd: PACKAGE_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const [{ filename }] = JSON.parse(out);
		const nodesDir = path.join(userFolder, '.n8n', 'nodes');
		const target = path.join(nodesDir, 'node_modules', 'n8n-nodes-technocore');
		mkdirSync(target, { recursive: true });
		execFileSync('tar', ['-xzf', path.join(work, filename), '-C', target, '--strip-components=1']);
		writeFileSync(
			path.join(nodesDir, 'package.json'),
			JSON.stringify({ name: 'installed-nodes', private: true }),
		);
		return readdirSync(path.join(target, 'dist'));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @returns a handle with `cli(args)` (a one-shot n8n CLI command), `start()` (the server)
 * and `dispose()`.
 */
export async function createN8nInstance() {
	const install = n8nInstall();
	const userFolder = mkdtempSync(path.join(os.tmpdir(), 'tc-n8n-user-'));
	installPackage(userFolder);
	const port = await freePort();
	const brokerPort = await freePort();
	const env = {
		...process.env,
		N8N_USER_FOLDER: userFolder,
		N8N_ENCRYPTION_KEY: randomBytes(24).toString('base64url'),
		N8N_PORT: String(port),
		N8N_LISTEN_ADDRESS: '127.0.0.1',
		N8N_HOST: '127.0.0.1',
		N8N_RUNNERS_BROKER_PORT: String(brokerPort),
		N8N_DIAGNOSTICS_ENABLED: 'false',
		N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
		N8N_TEMPLATES_ENABLED: 'false',
		N8N_PERSONALIZATION_ENABLED: 'false',
		N8N_SECURE_COOKIE: 'false',
		N8N_LOG_LEVEL: 'info',
		N8N_LOG_OUTPUT: 'console',
		DB_SQLITE_POOL_SIZE: '2',
		EXECUTIONS_DATA_SAVE_ON_SUCCESS: 'all',
		EXECUTIONS_DATA_SAVE_ON_ERROR: 'all',
		// n8n must not reinstall or phone home about community packages.
		N8N_REINSTALL_MISSING_PACKAGES: 'false',
	};
	// The test runner's environment (NODE_ENV=test, VITEST*, NODE_OPTIONS) changes how n8n
	// starts; give it a production-like one.
	for (const key of Object.keys(env)) {
		if (key === 'NODE_ENV' || key === 'NODE_OPTIONS' || key === 'TEST' || key.startsWith('VITEST'))
			delete env[key];
	}

	const cli = (args) => {
		const result = spawnSync(install.node, [install.bin, ...args], {
			cwd: userFolder,
			env,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
	};

	let server = null;
	const start = async () => {
		const child = spawn(install.node, [install.bin, 'start'], {
			cwd: userFolder,
			env,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let log = '';
		const append = (chunk) => {
			log = (log + chunk.toString()).slice(-200_000);
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		let exited = false;
		child.once('exit', () => {
			exited = true;
		});
		server = {
			child,
			get log() {
				return log;
			},
			get exited() {
				return exited;
			},
		};
		const deadline = Date.now() + 180_000;
		for (;;) {
			if (exited) throw new Error(`n8n exited during startup:\n${log.slice(-4000)}`);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/healthz/readiness`);
				if (response.status === 200) break;
			} catch {
				// not up yet
			}
			if (Date.now() > deadline) throw new Error(`n8n did not become ready:\n${log.slice(-4000)}`);
			await sleep(500);
		}
		// Readiness comes before active workflows are started; the editor line comes after.
		while (!log.includes('Editor is now accessible')) {
			if (exited) throw new Error(`n8n exited during startup:\n${log.slice(-4000)}`);
			if (Date.now() > deadline)
				throw new Error(`n8n did not finish starting workflows:\n${log.slice(-4000)}`);
			await sleep(250);
		}
		return server;
	};

	const stop = async () => {
		if (!server) return;
		const { child } = server;
		if (!server.exited) {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				// gone
			}
			const until = Date.now() + 30_000;
			while (!server.exited && Date.now() < until) await sleep(200);
			if (!server.exited) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					// gone
				}
			}
		}
		server = null;
	};

	const dispose = async () => {
		await stop();
		rmSync(userFolder, { recursive: true, force: true });
	};

	const importJson = (command, value) => {
		const file = path.join(userFolder, `${command.replace(':', '-')}-${Date.now()}.json`);
		writeFileSync(file, JSON.stringify(value));
		const result = cli([command, `--input=${file}`]);
		rmSync(file, { force: true });
		if (result.status !== 0) {
			throw new Error(
				`n8n ${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
			);
		}
		return result;
	};

	const exportNodeTypes = () => {
		const file = path.join(userFolder, 'node-types.json');
		const result = cli(['export:nodes', `--output=${file}`]);
		if (result.status !== 0) throw new Error(`n8n export:nodes failed:\n${result.stderr}`);
		return JSON.parse(readFileSync(file, 'utf8'));
	};

	const exportWorkflow = (id) => {
		const result = cli(['export:workflow', `--id=${id}`]);
		if (result.status !== 0) throw new Error(`n8n export:workflow failed:\n${result.stderr}`);
		const [workflow] = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
		return workflow;
	};

	return {
		install,
		userFolder,
		port,
		cli,
		start,
		stop,
		dispose,
		importJson,
		exportNodeTypes,
		exportWorkflow,
	};
}
