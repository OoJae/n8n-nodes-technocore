import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';

import { parseNoteBody } from '../../shared/responses';
import { API_CREDENTIAL, isSuccess, refusalError, requestText } from '../../shared/transport';
import { protocolError, validName } from '../../shared/validate';

const showOnlyForNoteRead = {
	resource: ['note'],
	operation: ['read'],
};

export const noteReadDescription: INodeProperties[] = [
	{
		displayName: 'If Not Found',
		name: 'notFound',
		type: 'options',
		options: [
			{
				name: 'Return Found = False',
				value: 'returnEmpty',
			},
			{
				name: 'Fail',
				value: 'error',
			},
		],
		default: 'returnEmpty',
		displayOptions: { show: showOnlyForNoteRead },
		description: 'What to do when nothing has been written at this path (or the note idled out)',
	},
];

export async function noteRead(this: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
	const ns = validName(
		this,
		this.getNodeParameter('namespace', itemIndex, ''),
		'namespace',
		itemIndex,
	);
	const key = validName(this, this.getNodeParameter('key', itemIndex, ''), 'key', itemIndex);
	const notFound = this.getNodeParameter('notFound', itemIndex, 'returnEmpty') as string;
	const response = await requestText(this, API_CREDENTIAL, {
		method: 'GET',
		path: `/kv/${ns}/${key}`,
	});
	if (response.status === 404 && notFound === 'returnEmpty') {
		return [{ namespace: ns, key, found: false }];
	}
	if (!isSuccess(response.status)) throw refusalError(this, response, itemIndex);
	let value: string;
	try {
		value = parseNoteBody(response.body);
	} catch (error) {
		throw protocolError(this, error, itemIndex);
	}
	return [{ namespace: ns, key, found: true, untrusted: true, value }];
}
