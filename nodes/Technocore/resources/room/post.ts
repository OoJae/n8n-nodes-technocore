import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeProperties } from 'n8n-workflow';

import { messageItem } from '../../shared/items';
import { isMailbox } from '../../shared/names';
import { parseRoomReply } from '../../shared/responses';
import { API_CREDENTIAL, isSuccess, refusalError, requestText } from '../../shared/transport';
import { protocolError, requireRoom, validName } from '../../shared/validate';

const showOnlyForRoomPost = {
	resource: ['room'],
	operation: ['post'],
};

export const roomPostDescription: INodeProperties[] = [
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		displayOptions: { show: showOnlyForRoomPost },
		description:
			'Message text, up to 4096 characters. The server turns control, format and line-separator characters (including newlines) into spaces.',
	},
	{
		displayName: 'Nickname',
		name: 'nick',
		type: 'string',
		default: '',
		displayOptions: { show: showOnlyForRoomPost },
		description:
			'Nickname to post as. Leave empty to use the Default Nickname from the credential.',
	},
];

export async function roomPost(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const room = requireRoom(this, itemIndex);
	if (isMailbox(room)) {
		throw new NodeOperationError(
			this.getNode(),
			`/r/${room} is a mailbox (mb-) room and accepts signed writes only`,
			{ itemIndex, description: 'Use the "Post Signed" operation with a Technocore Signing Key credential.' },
		);
	}
	const text = this.getNodeParameter('text', itemIndex, '') as string;
	if (typeof text !== 'string' || text.trim() === '') {
		throw new NodeOperationError(this.getNode(), 'The message text is empty', { itemIndex });
	}
	let nick = (this.getNodeParameter('nick', itemIndex, '') as string).trim();
	if (!nick) {
		const credentials = await this.getCredentials(API_CREDENTIAL);
		nick = typeof credentials.defaultNick === 'string' ? credentials.defaultNick.trim() : '';
	}
	nick = validName(this, nick, 'nickname', itemIndex);
	const response = await requestText(this, API_CREDENTIAL, {
		method: 'POST',
		path: `/r/${room}?format=json`,
		body: { from: nick, text },
	});
	if (!isSuccess(response.status)) throw refusalError(this, response, itemIndex);
	let reply;
	try {
		reply = parseRoomReply(response.body);
	} catch (error) {
		throw protocolError(this, error, itemIndex);
	}
	if (!reply.posted) throw protocolError(this, new Error('Technocore did not return the posted record'), itemIndex);
	return [{ ...messageItem(reply.view.room, reply.view.generation, reply.posted), type: 'posted' }];
}
