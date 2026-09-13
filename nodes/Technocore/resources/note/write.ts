import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeProperties,
} from 'n8n-workflow';

import { parseJsonObject } from '../../shared/responses';
import { API_CREDENTIAL, isSuccess, refusalError, requestText } from '../../shared/transport';
import { protocolError, validName } from '../../shared/validate';

const showOnlyForNoteWrite = {
	resource: ['note'],
	operation: ['write'],
};

export const noteWriteDescription: INodeProperties[] = [
	{
		displayName: 'Value',
		name: 'value',
		type: 'string',
		typeOptions: { rows: 3 },
		required: true,
		default: '',
		displayOptions: { show: showOnlyForNoteWrite },
		description:
			'Value to store, up to 8192 characters. Notes are world-writable and a note idle for 7 days is deleted.',
	},
	{
		displayName: 'Condition',
		name: 'condition',
		type: 'options',
		options: [
			{
				name: 'Always Write',
				value: 'none',
			},
			{
				name: 'Only If Absent',
				value: 'ifAbsent',
			},
			{
				name: 'Only If Unchanged',
				value: 'ifMatch',
			},
		],
		default: 'none',
		displayOptions: { show: showOnlyForNoteWrite },
		description: 'Compare-and-set condition. A lost condition fails with the current value.',
	},
	{
		displayName: 'Expected Current Value',
		name: 'expected',
		type: 'string',
		default: '',
		displayOptions: { show: { ...showOnlyForNoteWrite, condition: ['ifMatch'] } },
		description: 'Write only if the note still holds exactly this value',
	},
];

export async function noteWrite(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<IDataObject[]> {
	const ns = validName(
		this,
		this.getNodeParameter('namespace', itemIndex, ''),
		'namespace',
		itemIndex,
	);
	const key = validName(this, this.getNodeParameter('key', itemIndex, ''), 'key', itemIndex);
	const value = this.getNodeParameter('value', itemIndex, '') as string;
	if (typeof value !== 'string' || value.trim() === '') {
		throw new NodeOperationError(this.getNode(), 'The note value is empty', { itemIndex });
	}
	const condition = this.getNodeParameter('condition', itemIndex, 'none') as string;
	const body: IDataObject = { value };
	if (condition === 'ifAbsent') body.if_absent = true;
	if (condition === 'ifMatch') body.if = this.getNodeParameter('expected', itemIndex, '') as string;
	const response = await requestText(this, API_CREDENTIAL, {
		method: 'POST',
		path: `/kv/${ns}/${key}?format=json`,
		body,
	});
	if (!isSuccess(response.status)) throw refusalError(this, response, itemIndex);
	let meta: Record<string, unknown>;
	try {
		meta = parseJsonObject(response.body);
	} catch (error) {
		throw protocolError(this, error, itemIndex);
	}
	return [{ namespace: ns, key, written: true, ...(meta as IDataObject) }];
}
