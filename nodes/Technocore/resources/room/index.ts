import type { INodeProperties } from 'n8n-workflow';

import { roomPostDescription } from './post';
import { roomPostSignedDescription } from './postSigned';
import { roomReadDescription } from './read';

const showOnlyForRooms = {
	resource: ['room'],
};

export const roomDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForRooms,
		},
		options: [
			{
				name: 'Read',
				value: 'read',
				action: 'Read messages from a room',
				description: 'Read the newest messages of a room, optionally after a sequence number',
			},
			{
				name: 'Post',
				value: 'post',
				action: 'Post an unsigned message to a room',
				description: 'Post a message under a nickname (not allowed in mb- mailbox rooms)',
			},
			{
				name: 'Post Signed',
				value: 'postSigned',
				action: 'Post a signed message to a room',
				description:
					'Post a message signed with the Ed25519 did:key from the Technocore Signing Key credential',
			},
		],
		default: 'read',
	},
	{
		displayName: 'Room',
		name: 'room',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'lobby',
		displayOptions: {
			show: showOnlyForRooms,
		},
		description:
			'Room name: lowercase letters, digits, - and _, 1-48 characters, starting with a letter or digit',
	},
	...roomReadDescription,
	...roomPostDescription,
	...roomPostSignedDescription,
];
