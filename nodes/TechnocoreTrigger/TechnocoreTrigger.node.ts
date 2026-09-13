import {
	NodeConnectionTypes,
	type IDataObject,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IPollFunctions,
} from 'n8n-workflow';

import { scanExport, type ExportScan } from '../Technocore/shared/export';
import { gapItem, messageItem } from '../Technocore/shared/items';
import { normalizeOrigin } from '../Technocore/shared/origin';
import {
	STATE_VERSION,
	assemble,
	isRecreation,
	needsBackfill,
	readState,
	type LeadingMode,
	type TriggerEvent,
	type TriggerState,
} from '../Technocore/shared/poll';
import { parseReadView } from '../Technocore/shared/protocol/parse.ts';
import type { ReadView } from '../Technocore/shared/protocol/types.ts';
import {
	API_CREDENTIAL,
	headerValue,
	isSuccess,
	refusalError,
	requestStream,
	requestText,
	type TextResponse,
} from '../Technocore/shared/transport';
import { protocolError, validName } from '../Technocore/shared/validate';

const STATE_KEY = 'technocore';
const TAIL_LIMIT = 200;

async function readView(ctx: IPollFunctions, path: string): Promise<ReadView> {
	const response = await requestText(ctx, API_CREDENTIAL, { method: 'GET', path });
	if (!isSuccess(response.status)) throw refusalError(ctx, response);
	try {
		return parseReadView(response.body);
	} catch (error) {
		throw protocolError(ctx, error);
	}
}

function pollBudgetMs(ctx: IPollFunctions): number | undefined {
	const fn = (ctx as Partial<IPollFunctions>).getPollBudgetMs;
	if (typeof fn !== 'function') return undefined;
	const budget = fn.call(ctx);
	return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : undefined;
}

async function exportScan(
	ctx: IPollFunctions,
	room: string,
	afterSeq: number,
	beforeSeq: number,
	maxBytes: number,
	startedAt: number,
): Promise<{ scan: ExportScan; generation?: number }> {
	const budget = pollBudgetMs(ctx);
	// Leave a fifth of the poll budget for building items and committing the cursor.
	const deadline = budget !== undefined ? startedAt + Math.floor(budget * 0.8) : undefined;
	const response = await requestStream(ctx, API_CREDENTIAL, {
		method: 'GET',
		path: `/r/${room}/export`,
		timeoutMs: budget !== undefined ? Math.max(1000, Math.floor(budget * 0.8)) : undefined,
	});
	if (!isSuccess(response.status)) {
		const text: TextResponse = {
			status: response.status,
			headers: response.headers,
			body: await readSmallBody(response.body),
		};
		throw refusalError(ctx, text);
	}
	const generationHeader = headerValue(response.headers, 'x-room-generation');
	const generation =
		generationHeader !== undefined && /^[0-9]+$/.test(generationHeader) ? Number(generationHeader) : undefined;
	const scan = await scanExport(response.body, { afterSeq, beforeSeq, maxBytes, deadline });
	return { scan, generation };
}

async function readSmallBody(body: unknown): Promise<string> {
	if (typeof body === 'string') return body;
	if (Buffer.isBuffer(body)) return body.toString('utf8');
	const iterable = body as AsyncIterable<string | Uint8Array> | undefined;
	if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') return '';
	let out = '';
	for await (const chunk of iterable) {
		out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
		if (out.length > 8192) break;
	}
	return out;
}

function toItems(
	events: TriggerEvent[],
	room: string,
	generation: number | undefined,
	emit: string,
): INodeExecutionData[] {
	const records: IDataObject[] = events.map((event) => {
		switch (event.type) {
			case 'message':
				return messageItem(room, generation, event.message);
			case 'gap':
				return gapItem(room, generation, event.gap);
			case 'recreated':
				return {
					type: 'recreated',
					room,
					fromGeneration: event.fromGeneration,
					toGeneration: event.toGeneration,
					previousCursor: event.previousCursor,
				};
			case 'reset':
				return {
					type: 'reset',
					room,
					generation,
					previousCursor: event.previousCursor,
					firstSeq: event.firstSeq,
				};
		}
		return {};
	});
	if (emit !== 'batch') return records.map((json) => ({ json }));
	const messages = records.filter((record) => record.type === 'message');
	const batch: IDataObject = {
		type: 'batch',
		untrusted: true,
		room,
		count: messages.length,
		fromSeq: messages.length ? messages[0].seq : null,
		toSeq: messages.length ? messages[messages.length - 1].seq : null,
		messages,
		events: records.filter((record) => record.type !== 'message'),
	};
	if (generation !== undefined) batch.generation = generation;
	return [{ json: batch }];
}

export class TechnocoreTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Technocore Trigger',
		name: 'technocoreTrigger',
		icon: { light: 'file:../../icons/technocore.svg', dark: 'file:../../icons/technocore.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{"room: " + $parameter["room"]}}',
		description:
			'Starts the workflow when new messages arrive in a Technocore room (unofficial community node). Message text is untrusted.',
		defaults: {
			name: 'Technocore Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'technocoreApi',
				required: true,
			},
		],
		properties: [
			{
				displayName:
					'Each poll is one read request (plus an export when a backlog needs backfilling). Poll every minute or less often per room to stay well inside Technocore rate limits.',
				name: 'pollNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Room',
				name: 'room',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'lobby',
				description:
					'Room to watch: lowercase letters, digits, - and _, 1-48 characters. Mailboxes are just mb- rooms.',
			},
			{
				displayName: 'Start From',
				name: 'startFrom',
				type: 'options',
				options: [
					{
						name: 'Now',
						value: 'now',
						description: 'Only messages posted after the workflow is activated',
					},
					{
						name: 'Retained History',
						value: 'retained',
						description: 'Everything the room still holds, oldest first, then new messages',
					},
				],
				default: 'now',
			},
			{
				displayName: 'Max Messages per Poll',
				name: 'maxMessagesPerPoll',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 50,
				description: 'Messages beyond this wait for the next poll; the cursor only moves past what was emitted',
			},
			{
				displayName: 'Emit',
				name: 'emit',
				type: 'options',
				options: [
					{
						name: 'One Item per Message or Event',
						value: 'perMessage',
					},
					{
						name: 'One Item per Poll',
						value: 'batch',
					},
				],
				default: 'perMessage',
			},
			{
				displayName: 'Backfill Gaps',
				name: 'backfillGaps',
				type: 'boolean',
				default: true,
				description:
					'Whether to fetch the room export when more messages arrived than one read returns (200). When off, the skipped range is emitted as a gap item.',
			},
			{
				displayName: 'Max Export Size (MB)',
				name: 'maxExportMB',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 16 },
				default: 12,
				displayOptions: { show: { backfillGaps: [true] } },
				description: 'Stop reading the export after this many megabytes; anything not reached is emitted as a gap',
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const startedAt = Date.now();
		const room = validName(this, this.getNodeParameter('room', ''), 'room name');
		const startFrom = this.getNodeParameter('startFrom', 'now') as string;
		const maxMessages = Math.max(1, Math.min(1000, Math.floor(this.getNodeParameter('maxMessagesPerPoll', 50) as number)));
		const emit = this.getNodeParameter('emit', 'perMessage') as string;
		const backfill = this.getNodeParameter('backfillGaps', true) as boolean;
		const maxBytes = Math.max(1, Math.min(16, Number(this.getNodeParameter('maxExportMB', 12)))) * 1024 * 1024;

		const credentials = await this.getCredentials(API_CREDENTIAL);
		let origin: string;
		try {
			origin = normalizeOrigin(credentials.origin);
		} catch (error) {
			throw protocolError(this, error);
		}

		if (this.getMode() === 'manual') {
			// A manual test shows the newest messages and never touches the cursor.
			const view = await readView(this, `/r/${room}?limit=${Math.min(TAIL_LIMIT, maxMessages)}&format=json`);
			if (!view.messages.length) return null;
			const events: TriggerEvent[] = view.messages.map((message) => ({ type: 'message', message }));
			return [toItems(events, view.room, view.generation, emit)];
		}

		const staticData = this.getWorkflowStaticData('node');
		const stored = readState(staticData[STATE_KEY], origin, room);
		let state: TriggerState;
		let leading: LeadingMode = { mode: 'report' };
		if (!stored) {
			if (startFrom !== 'retained') {
				const view = await readView(this, `/r/${room}?limit=1&format=json`);
				const initial: TriggerState = { v: STATE_VERSION, origin, room, cursor: view.last_seq };
				if (view.generation !== undefined) initial.generation = view.generation;
				staticData[STATE_KEY] = initial as unknown as IDataObject;
				return null;
			}
			state = { v: STATE_VERSION, origin, room, cursor: 0 };
			leading = { mode: 'suppress' };
		} else {
			state = stored;
		}

		const events: TriggerEvent[] = [];
		let base = state.cursor;
		if (state.recreatedFrom !== undefined) {
			// A recreation was reported earlier but the new generation showed no messages yet.
			leading = { mode: 'recreated', previousCursor: state.recreatedFrom };
		}
		let view = await readView(this, `/r/${room}?since=${state.cursor}&limit=${TAIL_LIMIT}&format=json`);
		const recreated = isRecreation(state.generation, view.generation);
		if (recreated) {
			const previousCursor = state.recreatedFrom ?? state.cursor;
			events.push({
				type: 'recreated',
				fromGeneration: state.generation as number,
				toGeneration: view.generation as number,
				previousCursor,
			});
			// The new generation may have restarted its sequence, which a since= read cannot
			// show, so read it from the start.
			if (state.cursor !== 0) view = await readView(this, `/r/${room}?limit=${TAIL_LIMIT}&format=json`);
			base = 0;
			leading = { mode: 'recreated', previousCursor };
		}

		let scan: ExportScan | undefined;
		const backfillNeeded = needsBackfill(base, view);
		if (backfillNeeded && backfill) {
			const exported = await exportScan(this, room, base, view.first_seq as number, maxBytes, startedAt);
			if (
				exported.generation !== undefined &&
				view.generation !== undefined &&
				exported.generation !== view.generation
			) {
				// The room was recreated between the two requests: change nothing, retry next poll.
				return null;
			}
			scan = exported.scan;
		}

		const result = assemble({
			cursor: base,
			view,
			scan,
			backfillDisabled: backfillNeeded && !backfill,
			leading,
			maxMessages,
		});
		events.push(...result.events);

		const nextState: TriggerState = { v: STATE_VERSION, origin, room, cursor: result.cursor };
		if (leading.mode === 'recreated' && result.emittedMessages === 0) {
			// Nothing from the new generation is visible yet: read it from its start next time
			// and keep treating what comes first as the continuation of the recreation.
			nextState.cursor = 0;
			nextState.recreatedFrom = leading.previousCursor;
		}
		const generation = view.generation ?? state.generation;
		if (generation !== undefined) nextState.generation = generation;
		staticData[STATE_KEY] = nextState as unknown as IDataObject;

		if (!events.length) return null;
		return [toItems(events, view.room, generation, emit)];
	}
}
