/**
 * Hand-built IPollFunctions / IExecuteFunctions stubs. Requests go through the real
 * credential classes' `authenticate` (as n8n's CredentialsHelper does) and are then routed
 * to a fake responder, so tests see exactly what would be sent on the wire.
 */
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INode,
	INodeExecutionData,
	IPollFunctions,
} from 'n8n-workflow';

import { TechnocoreApi } from '../../credentials/TechnocoreApi.credentials';
import { TechnocoreSigningKeyApi } from '../../credentials/TechnocoreSigningKeyApi.credentials';
import type { FakeResponse } from './fake-technocore';

export type Router = (request: IHttpRequestOptions) => FakeResponse | Promise<FakeResponse>;

export interface CredentialData {
	technocoreApi?: IDataObject;
	technocoreSigningKeyApi?: IDataObject;
}

export interface RecordedRequest {
	credentialType: string;
	/** What the node asked for (before authenticate). */
	requested: IHttpRequestOptions;
	/** What would be sent (after authenticate). */
	sent: IHttpRequestOptions;
}

const credentialTypes = {
	technocoreApi: new TechnocoreApi(),
	technocoreSigningKeyApi: new TechnocoreSigningKeyApi(),
};

function node(type: string, name: string): INode {
	return {
		id: 'test-node',
		name,
		type,
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

function makeHelpers(credentials: CredentialData, router: Router, requests: RecordedRequest[]) {
	return {
		async httpRequestWithAuthentication(
			credentialType: string,
			requestOptions: IHttpRequestOptions,
		) {
			const type = credentialTypes[credentialType as keyof typeof credentialTypes];
			const data = credentials[credentialType as keyof CredentialData];
			if (!type || !data) throw new Error(`no credentials of type ${credentialType}`);
			const requested = structuredClone(requestOptions);
			const sent = await type.authenticate(
				{ ...data } as ICredentialDataDecryptedObject,
				requestOptions,
			);
			requests.push({ credentialType, requested, sent });
			const response = await router(sent);
			return {
				statusCode: response.status,
				headers: response.headers ?? {},
				body: response.body,
				statusMessage: '',
			};
		},
		returnJsonArray(items: IDataObject | IDataObject[]): INodeExecutionData[] {
			return (Array.isArray(items) ? items : [items]).map((json) => ({ json }));
		},
	};
}

export interface PollStubOptions {
	params: IDataObject;
	router: Router;
	mode?: 'trigger' | 'manual';
	staticData?: IDataObject;
	credentials?: CredentialData;
	pollBudgetMs?: number;
	nodeType?: string;
}

export function makePollFunctions(options: PollStubOptions) {
	const requests: RecordedRequest[] = [];
	const staticData: IDataObject = options.staticData ?? {};
	const credentials = options.credentials ?? {
		technocoreApi: { origin: 'https://technocore.test' },
	};
	const fns = {
		getNode: () =>
			node(options.nodeType ?? 'n8n-nodes-technocore.technocoreTrigger', 'Technocore Trigger'),
		getMode: () => options.mode ?? 'trigger',
		getActivationMode: () => 'activate',
		getNodeParameter: (name: string, fallback?: unknown) =>
			name in options.params ? options.params[name] : fallback,
		getWorkflowStaticData: () => staticData,
		getCredentials: async (type: string) => {
			const data = credentials[type as keyof CredentialData];
			if (!data) throw new Error(`no credentials of type ${type}`);
			return { ...data };
		},
		getPollBudgetMs: () => options.pollBudgetMs ?? 60_000,
		helpers: makeHelpers(credentials, options.router, requests),
	};
	return { fns: fns as unknown as IPollFunctions, requests, staticData };
}

export interface ExecuteStubOptions {
	params: IDataObject | IDataObject[];
	router: Router;
	credentials?: CredentialData;
	nodeType?: string;
	continueOnFail?: boolean;
}

export function makeExecuteFunctions(options: ExecuteStubOptions) {
	const requests: RecordedRequest[] = [];
	const perItem = Array.isArray(options.params) ? options.params : [options.params];
	const credentials = options.credentials ?? {
		technocoreApi: { origin: 'https://technocore.test' },
	};
	const fns = {
		getNode: () => node(options.nodeType ?? 'n8n-nodes-technocore.technocore', 'Technocore'),
		getInputData: () => perItem.map(() => ({ json: {} })),
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			const params = perItem[itemIndex] ?? {};
			return name in params ? params[name] : fallback;
		},
		getCredentials: async (type: string) => {
			const data = credentials[type as keyof CredentialData];
			if (!data) throw new Error(`no credentials of type ${type}`);
			return { ...data };
		},
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: makeHelpers(credentials, options.router, requests),
	};
	return { fns: fns as unknown as IExecuteFunctions, requests };
}
