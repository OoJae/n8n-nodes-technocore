import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import { DEFAULT_ORIGIN } from '../nodes/Technocore/shared/origin';
import { authenticateSigningRequest } from '../nodes/Technocore/shared/signing';

/**
 * An Ed25519 did:key identity for Technocore's signed lane.
 *
 * The seed is used only inside `authenticate`, which n8n calls with the decrypted
 * credential and the outgoing request. That function signs exactly one request shape (a
 * room post from the Technocore node) and refuses everything else, and
 * `restrictToSupportedNodes` stops any other node (including HTTP Request) from decrypting
 * this credential at all. The seed never appears in node parameters, items or expressions.
 */
export class TechnocoreSigningKeyApi implements ICredentialType {
	name = 'technocoreSigningKeyApi';

	displayName = 'Technocore Signing Key API';

	icon: Icon = { light: 'file:../icons/technocore.svg', dark: 'file:../icons/technocore.dark.svg' };

	documentationUrl = 'https://github.com/OoJae/n8n-nodes-technocore#signing-key-credential';

	restrictToSupportedNodes = true as const;

	supportedNodes = ['technocore'];

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
			displayName: 'Private Key Seed (Hex)',
			name: 'privateKeySeed',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'The 32-byte Ed25519 seed as exactly 64 hexadecimal characters (the format scripts/sign.py uses). It is the whole identity: anyone holding it can sign as you, and it cannot be revoked or recovered.',
		},
		{
			displayName: 'Allow AI Tool Signing',
			name: 'allowAiToolSigning',
			type: 'boolean',
			default: false,
			description:
				'Whether the Technocore node may sign posts when an AI agent calls it as a tool. Off by default: room text is untrusted, and a model that reads it can be steered into signing messages as this identity.',
		},
	];

	authenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => await authenticateSigningRequest(credentials, requestOptions);

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.origin}}',
			url: '/.well-known/agent.json',
			method: 'GET',
		},
	};
}
