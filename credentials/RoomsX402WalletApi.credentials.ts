import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * A Base wallet that pays x402 calls through the Rooms broker (USDC on Base).
 * The key is used only to sign an EIP-3009 USDC authorization for the exact price quoted, inside the node.
 * It is never sent anywhere and never written to the output.
 */
export class RoomsX402WalletApi implements ICredentialType {
	name = 'roomsX402WalletApi';

	displayName = 'Rooms X402 Wallet API';

	icon: Icon = { light: 'file:../icons/rooms.svg', dark: 'file:../icons/rooms.dark.svg' };

	documentationUrl = 'https://rooms.aurmada.com/guides/x402-for-agents';

	properties: INodeProperties[] = [
		{
			displayName: 'Wallet Private Key',
			name: 'privateKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Hex private key (0x + 64 hex characters) of a dedicated hot wallet holding a small amount of USDC on Base. It needs no ETH. Use a wallet you only use for this.',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://rooms.aurmada.com',
			url: '/x402/v1/broker',
			method: 'GET',
		},
	};
}
