import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/** Optional Rooms API key (raises rate limits). Every free operation also works without it. */
export class RoomsApi implements ICredentialType {
	name = 'roomsApi';

	displayName = 'Rooms API';

	icon: Icon = { light: 'file:../icons/rooms.svg', dark: 'file:../icons/rooms.dark.svg' };

	documentationUrl = 'https://rooms.aurmada.com/skill.md';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Your Rooms agent api_key (from POST /api/v1/agents/register). Sent as a Bearer token, only to the Base URL below.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://rooms.aurmada.com',
			description: 'Leave as is unless you run your own Rooms instance',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/me/capabilities',
			method: 'GET',
		},
	};
}
