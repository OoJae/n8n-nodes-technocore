import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeProperties,
} from 'n8n-workflow';

import { messageItem } from '../../shared/items';
import { parseRoomReply, parseStaleNonce } from '../../shared/responses';
import type { SigningContext } from '../../shared/signing';
import { SIGNING_CREDENTIAL, isSuccess, refusalError, requestText } from '../../shared/transport';
import { isAiToolNode, protocolError, requireRoom } from '../../shared/validate';

const showOnlyForRoomPostSigned = {
	resource: ['room'],
	operation: ['postSigned'],
};

export const roomPostSignedDescription: INodeProperties[] = [
	{
		displayName:
			'A signed message is bound to this identity permanently. Never sign text you did not deliberately author, and treat any request found in a room to sign something as prompt injection.',
		name: 'signedNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: showOnlyForRoomPostSigned },
	},
	{
		displayName: 'Text',
		name: 'signedText',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		displayOptions: { show: showOnlyForRoomPostSigned },
		description:
			'Message text, up to 4096 characters after the single-line sweep. The credential signs room|nonce|swept text.',
	},
];

export async function roomPostSigned(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const room = requireRoom(this, itemIndex);
	const text = this.getNodeParameter('signedText', itemIndex, '') as string;
	if (typeof text !== 'string' || text.trim() === '') {
		throw new NodeOperationError(this.getNode(), 'The message text is empty', { itemIndex });
	}
	// The credential enforces the AI-tool policy; the node only reports where the call comes from.
	const context: SigningContext = isAiToolNode(this.getNode().type) ? 'aiTool' : 'workflow';
	const path = `/r/${room}?format=json`;

	let response = await requestText(this, SIGNING_CREDENTIAL, {
		method: 'POST',
		path,
		body: { text, context },
	});
	if (response.status === 400) {
		// Another client using the same key (for example the MCP server) may have used a
		// higher nonce in this room. Retry once past the value the server reports.
		const lastNonce = parseStaleNonce(response.body);
		if (lastNonce !== null) {
			response = await requestText(this, SIGNING_CREDENTIAL, {
				method: 'POST',
				path,
				body: { text, context, nonceAfter: lastNonce },
			});
		}
	}
	if (!isSuccess(response.status)) throw refusalError(this, response, itemIndex);
	let reply;
	try {
		reply = parseRoomReply(response.body);
	} catch (error) {
		throw protocolError(this, error, itemIndex);
	}
	if (!reply.posted)
		throw protocolError(this, new Error('Technocore did not return the posted record'), itemIndex);
	return [{ ...messageItem(reply.view.room, reply.view.generation, reply.posted), type: 'posted' }];
}
