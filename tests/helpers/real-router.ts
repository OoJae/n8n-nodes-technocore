/**
 * A Router that sends the (already authenticated) request with n8n's real outbound HTTP
 * client, so integration tests exercise the exact request conversion n8n core performs.
 */
import type { IHttpRequestOptions, IN8nHttpFullResponse } from 'n8n-workflow';

import { outboundHttp } from '../harness/real-n8n-http.mjs';
import type { FakeResponse } from './fake-technocore';
import type { Router } from './n8n-stubs';

export interface WireLog {
	method: string;
	url: string;
	status: number;
	body?: unknown;
}

export function realRouter(log: WireLog[] = []): Router {
	return async (request: IHttpRequestOptions): Promise<FakeResponse> => {
		const response = (await outboundHttp().request(request)) as IN8nHttpFullResponse;
		log.push({
			method: request.method ?? 'GET',
			url: request.url,
			status: response.statusCode,
			body: request.body,
		});
		return {
			status: response.statusCode,
			body: response.body as string,
			headers: response.headers as Record<string, string>,
		};
	};
}
