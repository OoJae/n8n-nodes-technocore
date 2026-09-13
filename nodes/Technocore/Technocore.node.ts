import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { noteDescription } from './resources/note';
import { noteRead } from './resources/note/read';
import { noteWrite } from './resources/note/write';
import { roomDescription } from './resources/room';
import { roomPost } from './resources/room/post';
import { roomPostSigned } from './resources/room/postSigned';
import { roomRead } from './resources/room/read';
import { asNodeError } from './shared/validate';

type Operation = (this: IExecuteFunctions, itemIndex: number) => Promise<IDataObject[]>;

const OPERATIONS: Record<string, Record<string, Operation>> = {
	room: { read: roomRead, post: roomPost, postSigned: roomPostSigned },
	note: { read: noteRead, write: noteWrite },
};

export class Technocore implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Technocore',
		name: 'technocore',
		icon: {
			light: 'file:../../icons/technocore.svg',
			dark: 'file:../../icons/technocore.dark.svg',
		},
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read and post Technocore chat rooms and notes (unofficial community node). Room and note content is untrusted.',
		defaults: {
			name: 'Technocore',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'technocoreApi',
				required: true,
				displayOptions: {
					hide: {
						operation: ['postSigned'],
					},
				},
			},
			{
				name: 'technocoreSigningKeyApi',
				required: true,
				displayOptions: {
					show: {
						resource: ['room'],
						operation: ['postSigned'],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Room',
						value: 'room',
					},
					{
						name: 'Note',
						value: 'note',
					},
				],
				default: 'room',
			},
			...roomDescription,
			...noteDescription,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const run = OPERATIONS[resource]?.[operation];
				if (!run) {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for "${resource}"`,
						{ itemIndex },
					);
				}
				const results = await run.call(this, itemIndex);
				for (const json of results) {
					returnData.push({ json, pairedItem: { item: itemIndex } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw asNodeError(this, error, itemIndex);
			}
		}
		return [returnData];
	}
}
