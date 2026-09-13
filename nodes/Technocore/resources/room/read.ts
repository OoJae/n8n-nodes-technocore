import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

import { messageItem } from '../../shared/items';
import { parseReadView } from '../../shared/responses';
import { API_CREDENTIAL, isSuccess, refusalError, requestText } from '../../shared/transport';
import { protocolError, requireRoom } from '../../shared/validate';

const showOnlyForRoomRead = {
	resource: ['room'],
	operation: ['read'],
};

export const roomReadDescription: INodeProperties[] = [
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 200 },
		default: 50,
		displayOptions: { show: showOnlyForRoomRead },
		description: 'Max number of results to return',
	},
	{
		displayName: 'After Sequence Number',
		name: 'since',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		displayOptions: { show: showOnlyForRoomRead },
		description:
			'Only messages with a sequence number greater than this. 0 reads the newest messages. Technocore always returns the newest window, so if more than Limit messages are newer the output reports a gap.',
	},
	{
		displayName: 'Output',
		name: 'output',
		type: 'options',
		options: [
			{
				name: 'One Item per Message',
				value: 'perMessage',
			},
			{
				name: 'One Item with All Messages',
				value: 'batch',
			},
		],
		default: 'perMessage',
		displayOptions: { show: showOnlyForRoomRead },
	},
];

export async function roomRead(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const room = requireRoom(this, itemIndex);
	const limit = Math.max(1, Math.min(200, Math.floor(this.getNodeParameter('limit', itemIndex, 50) as number)));
	const since = Math.max(0, Math.floor(this.getNodeParameter('since', itemIndex, 0) as number));
	const output = this.getNodeParameter('output', itemIndex, 'perMessage') as string;
	const query = since > 0 ? `since=${since}&limit=${limit}&format=json` : `limit=${limit}&format=json`;
	const response = await requestText(this, API_CREDENTIAL, { method: 'GET', path: `/r/${room}?${query}` });
	if (!isSuccess(response.status)) throw refusalError(this, response, itemIndex);
	let view;
	try {
		view = parseReadView(response.body);
	} catch (error) {
		throw protocolError(this, error, itemIndex);
	}
	const gapDetected = since > 0 && view.first_seq !== null && view.first_seq > since + 1;
	const messages = view.messages.map((message) => messageItem(view.room, view.generation, message));
	if (output === 'batch') {
		const batch: IDataObject = {
			type: 'batch',
			untrusted: true,
			room: view.room,
			count: view.count,
			firstSeq: view.first_seq,
			lastSeq: view.last_seq,
			gapDetected,
			messages,
		};
		if (view.generation !== undefined) batch.generation = view.generation;
		if (gapDetected && view.first_seq !== null) {
			batch.gap = { from: since + 1, to: view.first_seq - 1 };
		}
		return [batch];
	}
	return messages.map((message) => ({ ...message, gapDetected }));
}
