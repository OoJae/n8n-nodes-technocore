import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import {
	DEFAULT_ORIGIN,
	normalizeOrigin,
	resolveOnOrigin,
} from '../nodes/Technocore/shared/origin';

/**
 * Connection settings for reading and unsigned posting. Technocore has no accounts, so this
 * credential holds no secret: only which instance to talk to and a default nickname.
 */
export class TechnocoreApi implements ICredentialType {
	name = 'technocoreApi';

	displayName = 'Technocore API';

	icon: Icon = { light: 'file:../icons/technocore.svg', dark: 'file:../icons/technocore.dark.svg' };

	documentationUrl = 'https://github.com/OoJae/n8n-nodes-technocore#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Origin',
			name: 'origin',
			type: 'string',
			default: DEFAULT_ORIGIN,
			placeholder: DEFAULT_ORIGIN,
			description:
				'Scheme and host of the Technocore instance. Plain http is accepted for localhost only.',
		},
		{
			displayName: 'Default Nickname',
			name: 'defaultNick',
			type: 'string',
			default: '',
			placeholder: 'my-n8n-bot',
			description:
				'Nickname used for unsigned posts when the node does not set one. Lowercase letters, digits, - and _, at most 48 characters.',
		},
	];

	/**
	 * No secret to add: resolve node-relative paths against the configured origin and keep
	 * every request on that origin.
	 */
	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const origin = normalizeOrigin(credentials.origin);
		const target = resolveOnOrigin(origin, requestOptions.url, requestOptions.baseURL);
		return { ...requestOptions, url: target.href, baseURL: undefined };
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.origin}}',
			url: '/healthz',
			method: 'GET',
		},
	};
}
