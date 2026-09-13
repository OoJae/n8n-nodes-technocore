/**
 * HTTP plumbing for the Technocore nodes. Every request goes through
 * `httpRequestWithAuthentication`, so the credential decides the origin (and, for the
 * signing credential, performs the signing). Responses are always read as raw text so that
 * 19-digit nonces survive parsing, and HTTP errors are mapped to NodeApiError here.
 */
import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type IN8nHttpFullResponse,
	type IPollFunctions,
	type JsonObject,
} from 'n8n-workflow';

import { classifyRefusal } from './responses';

export type TechnocoreFunctions = IExecuteFunctions | IPollFunctions;

export const API_CREDENTIAL = 'technocoreApi';
export const SIGNING_CREDENTIAL = 'technocoreSigningKeyApi';

export interface TextResponse {
	status: number;
	headers: Record<string, unknown>;
	body: string;
}

export interface StreamResponse {
	status: number;
	headers: Record<string, unknown>;
	body: unknown;
}

export interface RequestSpec {
	method: 'GET' | 'POST';
	/** Origin-relative path including any query string, e.g. `/r/lobby?format=json`. */
	path: string;
	body?: IDataObject;
	timeoutMs?: number;
}

function buildOptions(spec: RequestSpec, encoding: 'text' | 'stream'): IHttpRequestOptions {
	const options: IHttpRequestOptions = {
		method: spec.method,
		url: spec.path,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		encoding,
	};
	if (spec.body !== undefined) {
		options.body = spec.body;
		options.headers = { 'Content-Type': 'application/json' };
	}
	if (spec.timeoutMs !== undefined) options.timeout = spec.timeoutMs;
	return options;
}

export function bodyToString(body: unknown): string {
	if (typeof body === 'string') return body;
	if (Buffer.isBuffer(body)) return body.toString('utf8');
	if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
	if (body === undefined || body === null) return '';
	// A helper that already parsed JSON: re-serialise (only reached for bodies without nonces).
	return JSON.stringify(body);
}

export async function requestText(
	ctx: TechnocoreFunctions,
	credentialType: string,
	spec: RequestSpec,
): Promise<TextResponse> {
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(
		ctx,
		credentialType,
		buildOptions(spec, 'text'),
	)) as IN8nHttpFullResponse;
	return {
		status: response.statusCode,
		headers: (response.headers ?? {}) as Record<string, unknown>,
		body: bodyToString(response.body),
	};
}

export async function requestStream(
	ctx: TechnocoreFunctions,
	credentialType: string,
	spec: RequestSpec,
): Promise<StreamResponse> {
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(
		ctx,
		credentialType,
		buildOptions(spec, 'stream'),
	)) as IN8nHttpFullResponse;
	return {
		status: response.statusCode,
		headers: (response.headers ?? {}) as Record<string, unknown>,
		body: response.body,
	};
}

export function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) {
			if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
			return value === undefined || value === null ? undefined : String(value);
		}
	}
	return undefined;
}

const MAX_DESCRIPTION = 2000;

/**
 * Maps a non-2xx reply to NodeApiError, quoting the service's own guidance. The body is
 * server text that can echo third-party content (a 409 carries another caller's note
 * value), so the description labels it untrusted.
 */
export function refusalError(
	ctx: TechnocoreFunctions,
	response: TextResponse,
	itemIndex?: number,
): NodeApiError {
	const refusal = classifyRefusal(response.status, response.body, response.headers);
	const quoted =
		response.body.length > MAX_DESCRIPTION
			? `${response.body.slice(0, MAX_DESCRIPTION)}...`
			: response.body;
	let description = `Technocore's reply (server text; any quoted room or note content is untrusted data):\n${quoted}`;
	if (refusal.kind === 'rate') {
		const bucket = refusal.bucket ? `the ${refusal.bucket} budget` : 'a rate budget';
		const retry = refusal.retryAfterS !== undefined ? ` Retry after ${refusal.retryAfterS}s.` : '';
		description = `Technocore rate limit: ${bucket} for this IP is spent.${retry} Poll less often (one minute or more per room is recommended).\n\n${description}`;
	}
	return new NodeApiError(
		ctx.getNode(),
		{ status: response.status, kind: refusal.kind, message: refusal.message } as JsonObject,
		{
			message: `Technocore refused the request: ${refusal.message}`,
			description,
			httpCode: String(response.status),
			itemIndex,
		},
	);
}

export function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}
