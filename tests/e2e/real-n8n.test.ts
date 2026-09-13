/**
 * End to end in a REAL n8n (not stubs): the packed package installed as a community
 * package, credentials stored encrypted by n8n, workflows run by n8n's engine and its
 * poll scheduler, against a disposable LOCAL technocore-chat v0.13.0 server.
 * TEST seeds only; never production.
 *
 * Needs an n8n install on a Node.js release n8n supports; see tests/harness/real-n8n-instance.mjs.
 * Run with `npm run test:e2e` (it builds first).
 */
import { sleep } from 'n8n-workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	canonicalMessage,
	identityFromSeed,
	parseSeedHex,
	signCanonical,
	verifyCanonical,
} from '../../nodes/Technocore/shared/didkey';
import { parseReadView } from '../../nodes/Technocore/shared/responses';
import { TEST_SEEDS } from '../fixtures/corpus.mjs';
import { fetchLocal, postUnsigned, startTechnocore } from '../harness/local-server.mjs';
import { hasCheckout } from '../harness/python.mjs';
import { readRepoFile } from '../harness/repo-files.mjs';
import { createN8nInstance } from '../harness/real-n8n-instance.mjs';

if (!hasCheckout())
	throw new Error('e2e tests need a technocore-chat checkout (TECHNOCORE_CHECKOUT) and uv');

const identity = identityFromSeed(parseSeedHex(TEST_SEEDS.seed01));
const API = { id: 'tcApiE2e00000001', name: 'Technocore API (local)' };
const SIGNING = { id: 'tcSignE2e0000001', name: 'Technocore Signing Key (local)' };

type Instance = Awaited<ReturnType<typeof createN8nInstance>>;
let n8n: Instance;
let server: { origin: string; stop: () => Promise<void> };

async function readRoom(room: string) {
	const response = await fetchLocal(`${server.origin}/r/${room}?limit=200&format=json`);
	expect(response.status).toBe(200);
	return parseReadView(await response.text());
}

async function waitForMessages(room: string, count: number, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const view = await readRoom(room);
		if (view.messages.length >= count || Date.now() > deadline) return view;
		await sleep(1000);
	}
}

function manualWorkflow(id: string, name: string, nodes: object[]) {
	const [first, ...rest] = nodes as Array<{ name: string }>;
	const connections: Record<string, unknown> = {};
	let previous = 'Manual';
	for (const node of [first, ...rest]) {
		connections[previous] = { main: [[{ node: node.name, type: 'main', index: 0 }]] };
		previous = node.name;
	}
	return {
		id,
		name,
		active: false,
		settings: { executionOrder: 'v1' },
		connections,
		nodes: [
			{
				id: `${id}-m`,
				name: 'Manual',
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			},
			...nodes,
		],
	};
}

beforeAll(async () => {
	server = await startTechnocore();
	n8n = await createN8nInstance();
	n8n.importJson('import:credentials', [
		{ ...API, type: 'technocoreApi', data: { origin: server.origin, defaultNick: 'n8n-e2e' } },
		{
			...SIGNING,
			type: 'technocoreSigningKeyApi',
			data: {
				origin: server.origin,
				privateKeySeed: TEST_SEEDS.seed01,
				allowAiToolSigning: false,
			},
		},
	]);
});

afterAll(async () => {
	await n8n?.dispose();
	await server?.stop();
});

describe(`real n8n`, () => {
	it('loads the package as a community package: action node, trigger and the AI tool variant', () => {
		const types = n8n.exportNodeTypes() as Array<{
			name: string;
			usableAsTool?: boolean;
			polling?: boolean;
			credentials?: Array<{ name: string }>;
		}>;
		const ours = Object.fromEntries(
			types.filter((t) => t.name.startsWith('n8n-nodes-technocore.')).map((t) => [t.name, t]),
		);
		expect(Object.keys(ours).sort()).toEqual([
			'n8n-nodes-technocore.technocore',
			'n8n-nodes-technocore.technocoreTool',
			'n8n-nodes-technocore.technocoreTrigger',
		]);
		expect(ours['n8n-nodes-technocore.technocore'].usableAsTool).toBe(true);
		expect(ours['n8n-nodes-technocore.technocoreTrigger'].polling).toBe(true);
		expect(
			ours['n8n-nodes-technocore.technocoreTool'].credentials?.map((c) => c.name).sort(),
		).toEqual(['technocoreApi', 'technocoreSigningKeyApi']);
	});

	it('runs an unsigned and a signed post with credentials decrypted from n8n (server accepts both)', () => {
		n8n.importJson(
			'import:workflow',
			manualWorkflow('tcE2eManual00001', 'e2e manual posts', [
				{
					id: 'e2e-unsigned',
					name: 'Unsigned post',
					type: 'n8n-nodes-technocore.technocore',
					typeVersion: 1,
					position: [200, 0],
					parameters: {
						resource: 'room',
						operation: 'post',
						room: 'n8n-e2e-manual',
						text: '=unsigned from real n8n {{ 20 + 1 }}',
						nick: '',
					},
					credentials: { technocoreApi: API },
				},
				{
					id: 'e2e-signed',
					name: 'Signed post',
					type: 'n8n-nodes-technocore.technocore',
					typeVersion: 1,
					position: [400, 0],
					parameters: {
						resource: 'room',
						operation: 'postSigned',
						room: 'n8n-e2e-manual',
						signedText: '=signed from real n8n {{ $json.seq }}',
					},
					credentials: { technocoreSigningKeyApi: SIGNING },
				},
			]),
		);
		const result = n8n.cli(['execute', '--id=tcE2eManual00001', '--rawOutput']);
		expect(result.status, `${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`).toBe(0);
		expect(result.stdout).toContain('"status": "success"');
		// The execution data holds public output only: the did, never the seed.
		expect(result.stdout).toContain(identity.did);
		expect(result.stdout).not.toContain(TEST_SEEDS.seed01);
	});

	it('the stored signed record verifies against the test did', async () => {
		const view = await readRoom('n8n-e2e-manual');
		expect(view.messages.map((m) => [m.from, m.text])).toEqual([
			['n8n-e2e', 'unsigned from real n8n 21'],
			[identity.did, 'signed from real n8n 1'],
		]);
		const signed = view.messages[1];
		expect(
			verifyCanonical(
				identity.did,
				signed.sig as string,
				canonicalMessage('n8n-e2e-manual', signed.nonce as string, signed.text),
			),
		).toBe(true);
	});

	it('restrictToSupportedNodes stops the HTTP Request node from using the signing credential', async () => {
		n8n.importJson(
			'import:workflow',
			manualWorkflow('tcE2eOracle00001', 'e2e signing oracle attempt', [
				{
					id: 'e2e-http',
					name: 'HTTP Request',
					type: 'n8n-nodes-base.httpRequest',
					typeVersion: 4.2,
					position: [200, 0],
					parameters: {
						method: 'POST',
						url: `${server.origin}/r/n8n-e2e-oracle?format=json`,
						authentication: 'predefinedCredentialType',
						nodeCredentialType: 'technocoreSigningKeyApi',
						sendBody: true,
						specifyBody: 'json',
						jsonBody: '{"text":"oracle attempt","context":"workflow"}',
						options: {},
					},
					credentials: { technocoreSigningKeyApi: SIGNING },
				},
			]),
		);
		const result = n8n.cli(['execute', '--id=tcE2eOracle00001', '--rawOutput']);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			'Credential type "technocoreSigningKeyApi" is restricted to specific nodes',
		);
		expect((await readRoom('n8n-e2e-oracle')).messages).toEqual([]);
	});

	it('the shipped examples/workflows/local-smoke.json runs its unsigned + signed posts', async () => {
		const workflow = JSON.parse(readRepoFile('examples/workflows/local-smoke.json'));
		for (const node of workflow.nodes) {
			for (const [type, reference] of Object.entries(node.credentials ?? {})) {
				expect(reference).toMatchObject({ id: 'REPLACE_ME' });
				node.credentials[type] = type === 'technocoreSigningKeyApi' ? SIGNING : API;
			}
		}
		expect(workflow.nodes.map((n: { name: string }) => n.name)).toContain('Technocore Trigger');
		workflow.id = 'tcE2eSmoke000001';
		n8n.importJson('import:workflow', workflow);
		const result = n8n.cli(['execute', '--id=tcE2eSmoke000001', '--rawOutput']);
		expect(result.status, result.stderr.slice(-2000)).toBe(0);
		const view = await readRoom('n8n-smoke');
		expect(view.messages.map((m) => m.from)).toEqual(['n8n-smoke', identity.did]);
		expect(view.messages[0].text).toMatch(/^unsigned smoke [0-9]+$/);
		const signed = view.messages[1];
		expect(
			verifyCanonical(
				identity.did,
				signed.sig as string,
				canonicalMessage('n8n-smoke', signed.nonce as string, signed.text),
			),
		).toBe(true);
	});

	describe('Technocore Trigger under n8n poll scheduling', () => {
		const room = 'n8n-e2e-watch';
		const sink = 'n8n-e2e-sink';

		beforeAll(async () => {
			n8n.importJson('import:workflow', {
				id: 'tcE2eTrigger0001',
				name: 'e2e trigger to sink',
				active: false,
				settings: { executionOrder: 'v1' },
				connections: { Trigger: { main: [[{ node: 'Sink', type: 'main', index: 0 }]] } },
				nodes: [
					{
						id: 'e2e-trigger',
						name: 'Trigger',
						type: 'n8n-nodes-technocore.technocoreTrigger',
						typeVersion: 1,
						position: [0, 0],
						parameters: {
							pollTimes: { item: [{ mode: 'everyMinute' }] },
							room,
							startFrom: 'now',
							maxMessagesPerPoll: 1000,
							emit: 'batch',
						},
						credentials: { technocoreApi: API },
					},
					{
						// Echo only counts and seqs, never message text (room text is untrusted).
						id: 'e2e-sink',
						name: 'Sink',
						type: 'n8n-nodes-technocore.technocore',
						typeVersion: 1,
						position: [200, 0],
						parameters: {
							resource: 'room',
							operation: 'post',
							room: sink,
							text: '=batch count={{ $json.count }} from={{ $json.fromSeq }} to={{ $json.toSeq }} events={{ $json.events.length }} signed={{ $json.messages.filter(m => m.signed).length }}',
							nick: 'n8n-e2e-sink',
						},
						credentials: { technocoreApi: API },
					},
				],
			});
			for (const id of ['tcE2eTrigger0001', 'tcE2eSmoke000001']) {
				const published = n8n.cli(['publish:workflow', `--id=${id}`]);
				expect(published.status, published.stderr).toBe(0);
			}
		});

		function storedState(workflowId: string, nodeName: string) {
			return n8n.exportWorkflow(workflowId).staticData?.[`node:${nodeName}`]?.technocore;
		}
		const storedCursor = () => storedState('tcE2eTrigger0001', 'Trigger');

		async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number) {
			const deadline = Date.now() + timeoutMs;
			while (!(await condition()) && Date.now() < deadline) await sleep(1000);
		}

		it('activation stores the head (Start From = now) and emits nothing', async () => {
			await postUnsigned(server.origin, room, 'before', 'posted before activation 1');
			await postUnsigned(server.origin, room, 'before', 'posted before activation 2');
			await n8n.start();
			await waitFor(() => storedCursor()?.cursor === 2, 60_000);
			expect(storedCursor()).toMatchObject({ v: 1, room, cursor: 2, generation: 1 });
			await n8n.stop();
			expect((await readRoom(sink)).messages).toEqual([]);
		});

		it('a 250-message backlog (one signed) posted while n8n was down arrives as one backfilled batch', async () => {
			for (let i = 1; i <= 249; i++) {
				await postUnsigned(server.origin, room, 'writer', `backlog message ${i}`);
			}
			const nonce = String(Date.now());
			const text = 'the one signed message in the backlog';
			const response = await fetchLocal(`${server.origin}/r/${room}?format=json`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					did: identity.did,
					nonce,
					text,
					sig: signCanonical(identity.privateKey, canonicalMessage(room, nonce, text)),
				}),
			});
			expect(response.status).toBe(200);

			// Restarting reuses the stored cursor. A 200-message tail read cannot hold 250, so
			// the first poll must backfill the oldest 50 from the export.
			await n8n.start();
			const view = await waitForMessages(sink, 1, 150_000);
			expect(view.messages.map((m) => m.text)).toEqual([
				'batch count=250 from=3 to=252 events=0 signed=1',
			]);
			await waitFor(() => storedCursor()?.cursor === 252, 30_000);
			expect(storedCursor()).toMatchObject({ v: 1, room, cursor: 252, generation: 1 });
		});

		it('scheduled polls deliver new messages exactly once (this workflow and the shipped local-smoke example)', async () => {
			expect(storedState('tcE2eSmoke000001', 'Technocore Trigger')).toMatchObject({
				room: 'n8n-smoke',
				cursor: 2,
			});
			for (let i = 1; i <= 3; i++) {
				await postUnsigned(server.origin, room, 'writer', `while running ${i}`);
			}
			await postUnsigned(server.origin, 'n8n-smoke', 'writer', 'for the example trigger');

			// Wait for n8n's poll scheduler (every minute) to pick all of them up.
			await waitFor(async () => {
				const texts = (await readRoom(sink)).messages.map((m) => m.text);
				return texts.length > 1 && storedCursor()?.cursor === 255;
			}, 150_000);
			await waitFor(
				() => storedState('tcE2eSmoke000001', 'Technocore Trigger')?.cursor === 3,
				90_000,
			);
			await n8n.stop();

			const texts = (await readRoom(sink)).messages.map((m) => m.text);
			expect(texts[0]).toBe('batch count=250 from=3 to=252 events=0 signed=1');
			// Normally one batch; a scheduler tick between two of the three posts splits it. Either
			// way the batches must be contiguous and cover 253..255 exactly once.
			const later = texts.slice(1).map((t) => {
				const match = /^batch count=(\d+) from=(\d+) to=(\d+) events=0 signed=0$/.exec(t);
				expect(match, t).not.toBeNull();
				return { count: Number(match![1]), from: Number(match![2]), to: Number(match![3]) };
			});
			let next = 253;
			for (const batch of later) {
				expect(batch.from).toBe(next);
				expect(batch.to - batch.from + 1).toBe(batch.count);
				next = batch.to + 1;
			}
			expect(next).toBe(256);
			expect(storedCursor()).toMatchObject({ cursor: 255 });
			expect(storedState('tcE2eSmoke000001', 'Technocore Trigger')).toMatchObject({ cursor: 3 });
		});
	});
});
