import { NodeApiError, NodeOperationError, type IExecuteFunctions, type IPollFunctions } from 'n8n-workflow';

import { NAME_RE } from './names';

type Functions = IExecuteFunctions | IPollFunctions;

export function validName(ctx: Functions, value: unknown, label: string, itemIndex?: number): string {
	const name = typeof value === 'string' ? value.trim() : '';
	if (!NAME_RE.test(name)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid ${label} "${name.slice(0, 60)}": expected lowercase letters, digits, - and _, 1-48 characters, starting with a letter or digit`,
			{ itemIndex },
		);
	}
	return name;
}

export function requireRoom(ctx: IExecuteFunctions, itemIndex: number): string {
	return validName(ctx, ctx.getNodeParameter('room', itemIndex, ''), 'room name', itemIndex);
}

export function protocolError(ctx: Functions, error: unknown, itemIndex?: number): NodeOperationError {
	const message = error instanceof Error ? error.message : 'Technocore returned an unexpected response';
	return new NodeOperationError(ctx.getNode(), message, { itemIndex });
}

/** n8n registers an AI-tool copy of every `usableAsTool` node under `<name>Tool`. */
export function isAiToolNode(nodeType: string): boolean {
	const name = nodeType.split('.').pop() ?? '';
	return name.endsWith('Tool') || name.startsWith('tool');
}

const NODE_ERROR_NAMES = new Set(['NodeApiError', 'NodeOperationError']);

/** Passes n8n node errors through unchanged and wraps anything else in NodeOperationError. */
export function asNodeError(ctx: Functions, error: unknown, itemIndex?: number): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof Error && NODE_ERROR_NAMES.has(error.constructor.name)) {
		return error as NodeOperationError;
	}
	return new NodeOperationError(ctx.getNode(), error instanceof Error ? error : String(error), { itemIndex });
}
