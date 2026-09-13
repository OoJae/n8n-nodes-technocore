import { describe, expect, it } from 'vitest';

import { check } from '../../scripts/vendor-core.mjs';
import { findHexSecrets, loadAllowList, scan } from '../../scripts/secret-scan.mjs';
import { exampleWorkflows, readRepoFile } from '../harness/repo-files.mjs';

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
			expect(workflow.nodes.some((n: { type: string }) => n.type.startsWith('n8n-nodes-technocore.')), name).toBe(true);
			expect(text, name).not.toMatch(/privateKeySeed|[0-9a-f]{64}/i);
		}
	});
});

describe('secret scan', () => {
	it('finds no unlisted 64-hex strings in tracked files', () => {
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
});

describe('vendored protocol', () => {
	it('matches the integrity hashes in VENDOR.json', () => {
		const { errors } = check();
		expect(errors).toEqual([]);
	});
});
