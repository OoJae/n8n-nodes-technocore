// n8n's real outbound HTTP client (@n8n/backend-network OutboundHttp), the code path n8n
// core uses after a credential's `authenticate` has run. tests/helpers/n8n-stubs.ts runs the
// credential step; tests/helpers/real-router.ts sends the result through this client.
// Test-only; never shipped.
import { createRequire } from 'node:module';

// Loaded through Node's CommonJS loader: the packages' ESM entry points reference sources
// that are not published.
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { Container } = require('@n8n/di');
const { OutboundHttp } = require('@n8n/backend-network');

export function outboundHttp() {
	return Container.get(OutboundHttp).requests();
}
