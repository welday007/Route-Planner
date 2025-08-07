import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';

export async function startClient(transport: Transport) {
  const client = new Client({name: 'AI Studio', version: '1.0.0'});
  await client.connect(transport);
  return client;
}
