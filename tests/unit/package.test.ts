import { describe, expect, it } from 'vitest';

import { check } from '../../scripts/vendor-core.mjs';
import {
	findEmails,
	findEmailsInBuffer,
	findHexSecrets,
	findHexSecretsInBuffer,
	loadAllowList,
	scan,
} from '../../scripts/secret-scan.mjs';
import { exampleWorkflows, readRepoFile, repoFileExists } from '../harness/repo-files.mjs';
import { withTempGitRepo } from '../harness/temp-git-repo.mjs';

const pkg = JSON.parse(readRepoFile('package.json'));

describe('package metadata (n8n community node requirements)', () => {
	it('has no runtime dependencies, MIT license and the community keyword', () => {
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.license).toBe('MIT');
		expect(pkg.name).toBe('n8n-nodes-technocore');
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.files).toEqual(['dist']);
		expect(pkg.peerDependencies).toEqual({ 'n8n-workflow': '*' });
		expect(pkg.n8n.strict).toBe(true);
		expect(pkg.n8n.nodes).toEqual([
			'dist/nodes/Technocore/Technocore.node.js',
			'dist/nodes/TechnocoreTrigger/TechnocoreTrigger.node.js',
		]);
	});

	it('names the author and the GitHub repository without any email address', () => {
		expect(pkg.author).toEqual({ name: 'OoJae', url: 'https://github.com/OoJae' });
		expect(JSON.stringify(pkg)).not.toMatch(/"email"/);
		expect(findEmails(readRepoFile('package.json'))).toEqual([]);
		expect(pkg.repository).toEqual({
			type: 'git',
			url: 'https://github.com/OoJae/n8n-nodes-technocore.git',
		});
		expect(pkg.homepage).toBe('https://github.com/OoJae/n8n-nodes-technocore#readme');
		expect(pkg.bugs).toEqual({ url: 'https://github.com/OoJae/n8n-nodes-technocore/issues' });
	});

	it('ships a LICENSE and a README that states it is unofficial', () => {
		expect(readRepoFile('LICENSE.md')).toMatch(/MIT License/);
		expect(readRepoFile('README.md')).toContain(
			'Unofficial community integration — not affiliated with or endorsed by FLOP Labs.',
		);
	});

	it('uses the unmodified starter eslint config (strict mode)', () => {
		expect(readRepoFile('eslint.config.mjs').replace(/\s+/g, ' ').trim()).toBe(
			"import { config } from '@n8n/node-cli/eslint'; export default config;",
		);
	});
});

describe('example workflows', () => {
	it('are valid n8n workflow JSON using this package and carry no key material', () => {
		const workflows = exampleWorkflows();
		expect(workflows.length).toBeGreaterThanOrEqual(2);
		for (const { name, text } of workflows) {
			const workflow = JSON.parse(text);
			expect(Array.isArray(workflow.nodes), name).toBe(true);
			expect(typeof workflow.connections, name).toBe('object');
			expect(
				workflow.nodes.some((n: { type: string }) => n.type.startsWith('n8n-nodes-technocore.')),
				name,
			).toBe(true);
			expect(text, name).not.toMatch(/privateKeySeed|[0-9a-f]{64}/i);
		}
	});
});

describe('secret scan', () => {
	it('finds no email addresses and no unlisted 64-hex strings in tracked files', () => {
		const { problems } = scan();
		expect(problems).toEqual([]);
	});

	it('flags a 64-hex run and accepts only allow-listed test vectors', () => {
		const allowed = loadAllowList();
		const synthetic = 'ab'.repeat(32);
		expect(findHexSecrets(`const x = "${synthetic}";`, allowed)).toHaveLength(1);
		expect(findHexSecrets(`longer ${'cd'.repeat(40)} run`, allowed)).toHaveLength(1);
		expect(findHexSecrets(`short ${'ef'.repeat(31)} run`, allowed)).toHaveLength(0);
		expect(findHexSecrets(`seed ${'01'.repeat(32)}`, allowed)).toHaveLength(0);
		for (const label of allowed.values()) expect(label).toMatch(/TEST/);
	});

	it('also finds hex runs in UTF-16 (LE, BE, with or without BOM) and binary files', () => {
		const allowed = loadAllowList();
		const synthetic = 'ab'.repeat(32);
		const text = `SEED=${synthetic}\r\n`;
		const le = Buffer.from(text, 'utf16le');
		const be = Buffer.from(le).swap16();
		const cases: Record<string, Buffer> = {
			'utf-16le': le,
			'utf-16le with BOM': Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
			'utf-16be': be,
			'utf-16be with BOM': Buffer.concat([Buffer.from([0xfe, 0xff]), be]),
			binary: Buffer.concat([
				Buffer.from([0, 1, 2, 0, 255]),
				Buffer.from(synthetic),
				Buffer.alloc(9000),
			]),
			'binary, seed after 8000 NUL bytes': Buffer.concat([
				Buffer.alloc(8000),
				Buffer.from(text, 'utf16le'),
			]),
		};
		for (const [name, buffer] of Object.entries(cases)) {
			expect(findHexSecretsInBuffer(buffer, allowed), name).toHaveLength(1);
		}
		const allowedSeed = Buffer.from(`seed ${'01'.repeat(32)}`, 'utf16le');
		expect(findHexSecretsInBuffer(allowedSeed, allowed)).toHaveLength(0);
		expect(findHexSecretsInBuffer(Buffer.from(`plain ${synthetic}`), allowed)).toHaveLength(1);
	});

	it('refuses a staged UTF-16 file holding a hex seed (the pre-commit path) and scans the given root', () => {
		withTempGitRepo(({ root, write, git }) => {
			write('.secret-scan-allow.json', readRepoFile('.secret-scan-allow.json'));
			write('clean.txt', 'nothing here\n');
			git('add', '.');
			expect(scan({ staged: true, root }).problems).toEqual([]);
			const notes = Buffer.concat([
				Buffer.from([0xff, 0xfe]),
				Buffer.from(`key: ${'cd'.repeat(32)}\r\n`, 'utf16le'),
			]);
			write('notes.txt', notes);
			git('add', 'notes.txt');
			const staged = scan({ staged: true, root });
			expect(staged.problems).toHaveLength(1);
			expect(staged.problems[0]).toMatchObject({ file: 'notes.txt', line: 1, length: 64 });
			expect(JSON.stringify(staged.problems)).not.toContain('cd'.repeat(32));
			expect(scan({ root }).problems).toHaveLength(1);
		});
	});
});

describe('email scan', () => {
	// Addresses are assembled at run time so this file holds none itself.
	const at = (local: string, domain: string) => [local, domain].join('@');

	it('flags email addresses but not URL credentials or package specs', () => {
		for (const text of [
			`"email": "${at('someone', 'example.com')}"`,
			`mailto:${at('first.last+tag', 'mail.example.co.uk')}`,
			`Name <${at('x_y-z', 'sub.example.org')}> (https://example.org)`,
		]) {
			expect(findEmails(text), text).toHaveLength(1);
		}
		for (const text of [
			"{ origin: 'https://user:pw@technocore.test' }",
			'ssh://git@github.com/OoJae/n8n-nodes-technocore.git',
			'npm install n8n@2.38.7 npm@latest @n8n/node-cli@0.47.2',
			'user@localhost',
		]) {
			expect(findEmails(text), text).toEqual([]);
		}
		expect(findEmails(`a\nb\ncontact: ${at('someone', 'example.com')}`)).toEqual([
			{ line: 3, kind: 'email' },
		]);
	});

	it('finds email addresses in UTF-16 content and never reports the address', () => {
		const le = Buffer.from(`author: ${at('someone', 'example.com')}\r\n`, 'utf16le');
		expect(findEmailsInBuffer(le)).toEqual([{ line: 1, kind: 'email', encoding: 'utf-16le' }]);
		expect(findEmailsInBuffer(Buffer.from(le).swap16())).toEqual([
			{ line: 1, kind: 'email', encoding: 'utf-16be' },
		]);
	});

	it('refuses a staged file holding an email address (the pre-commit path)', () => {
		withTempGitRepo(({ root, write, git }) => {
			write('.secret-scan-allow.json', readRepoFile('.secret-scan-allow.json'));
			write('package.json', '{ "author": { "name": "x", "url": "https://example.org" } }\n');
			git('add', '.');
			expect(scan({ staged: true, root }).problems).toEqual([]);
			write(
				'package.json',
				`{ "author": { "name": "x", "email": "${at('x', 'example.org')}" } }\n`,
			);
			git('add', 'package.json');
			const staged = scan({ staged: true, root });
			expect(staged.problems).toEqual([{ file: 'package.json', line: 1, kind: 'email' }]);
			expect(JSON.stringify(staged.problems)).not.toContain(at('x', 'example.org'));
		});
	});
});

describe('publish workflow', () => {
	const workflow = readRepoFile('.github/workflows/publish.yml');

	it('publishes with provenance through trusted publishing on npm >= 11.5.1', () => {
		expect(workflow).toMatch(/^\s+id-token: write$/m);
		expect(workflow).toMatch(/^\s+node-version: '24'$/m);
		expect(workflow).not.toMatch(/node-version: 'lts\/\*'/);
		expect(workflow).toContain('at_least "$(npm --version)" 11.5.1 || {');
		expect(workflow).toContain('npm install -g npm@^11.5.1');
		expect(workflow).toMatch(/^\s+NPM_CONFIG_PROVENANCE: 'true'$/m);
		expect(workflow).toMatch(/^\s+npm run release$/m);
		expect(workflow.indexOf('- name: Ensure npm >= 11.5.1')).toBeGreaterThan(0);
		expect(workflow.indexOf('- name: Ensure npm >= 11.5.1')).toBeLessThan(
			workflow.search(/^\s+npm run release$/m),
		);
	});

	it('keeps the *.*.* tag pattern, refuses tags that are not the package version, and names OoJae', () => {
		expect(workflow).toMatch(/^\s+tags:\n(?:\s+#.*\n)*\s+- '\*\.\*\.\*'$/m);
		expect(workflow).toContain('if [ "$GITHUB_REF_NAME" != "$version" ]; then');
		expect(workflow).not.toMatch(/<your-/);
		expect(workflow).toMatch(/Organization or user: OoJae\n#\s+Repository:\s+n8n-nodes-technocore/);
		const releasing = readRepoFile('README.md').split('\n## Releasing\n')[1]?.split('\n## ')[0];
		expect(releasing).toBeDefined();
		expect(releasing).toContain('`*.*.*`');
	});
});

describe('README commands', () => {
	it('runs every script with the interpreter its file is written for', () => {
		const readme = readRepoFile('README.md');
		const nodeScripts = [...readme.matchAll(/`node (scripts\/[^\s`]+)/g)].map((m) => m[1]);
		expect(nodeScripts.length).toBeGreaterThan(0);
		for (const script of nodeScripts) {
			expect(script, script).toMatch(/\.(mjs|js|cjs)$/);
			expect(repoFileExists(script), script).toBe(true);
		}
		const pythonCommands = [...readme.matchAll(/`([^`]*scripts\/gen-sweep-table\.py[^`]*)`/g)].map(
			(m) => m[1],
		);
		expect(pythonCommands.some((c) => /uv run python .*scripts\/gen-sweep-table\.py/.test(c))).toBe(
			true,
		);
		for (const command of pythonCommands) expect(command).not.toMatch(/(^|\s)node\s/);
	});
});

describe('vendored protocol', () => {
	it('matches the integrity hashes in VENDOR.json', () => {
		const { errors } = check();
		expect(errors).toEqual([]);
	});
});
