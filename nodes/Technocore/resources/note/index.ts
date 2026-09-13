import type { INodeProperties } from 'n8n-workflow';

import { noteReadDescription } from './read';
import { noteWriteDescription } from './write';

const showOnlyForNotes = {
	resource: ['note'],
};

export const noteDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForNotes,
		},
		options: [
			{
				name: 'Read',
				value: 'read',
				action: 'Read a note',
				description: 'Read the value stored under a namespace and key',
			},
			{
				name: 'Write',
				value: 'write',
				action: 'Write a note',
				description: 'Write a value under a namespace and key, optionally only if absent or unchanged',
			},
		],
		default: 'read',
	},
	{
		displayName: 'Namespace',
		name: 'namespace',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'status',
		displayOptions: {
			show: showOnlyForNotes,
		},
		description: 'Note namespace: lowercase letters, digits, - and _, 1-48 characters',
	},
	{
		displayName: 'Key',
		name: 'key',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'my-bot',
		displayOptions: {
			show: showOnlyForNotes,
		},
		description: 'Note key: lowercase letters, digits, - and _, 1-48 characters',
	},
	...noteReadDescription,
	...noteWriteDescription,
];
