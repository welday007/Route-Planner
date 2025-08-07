/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This is the main entry point for the application.
 * It sets up the LitElement-based MapApp component, initializes the Google GenAI
 * client for chat interactions, and establishes communication between the
 * Model Context Protocol (MCP) client and server. The MCP server exposes
 * map-related tools that the AI model can use, and the client relays these
 * tool calls to the server.
 */

import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ChatState, MapApp, marked} from './map_app.js'; // Updated import path

import {MapParams, startMcpGoogleMapServer} from './mcp_maps_server.js';
import {startClient} from './client.js';
import {createAiChat} from './chat_utils.js';
import {createSendMessageHandler} from './send_message_handler.js';

document.addEventListener('DOMContentLoaded', async (event) => {
  const rootElement = document.querySelector('#root')! as HTMLElement;

  const mapApp = document.createElement('gdm-map-app') as MapApp & HTMLElement;
  // The Google Maps API key is now managed within the map_app component.
  rootElement.appendChild(mapApp);

  // Read the Gemini API key from the environment. The vite config exposes
  // `GEMINI_API_KEY` to the client, so we reference that variable directly.
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey) {
    const errorMessage = await marked.parse(
      '**Configuration Error:** The Gemini API Key is missing. Please add `GEMINI_API_KEY=YOUR_KEY_HERE` to your `.env` file to enable the chat. You may need to restart the server after creating the file.',
    );
    mapApp.addMessage('error', errorMessage);
    mapApp.setChatState(ChatState.IDLE); // Ensure UI is not locked
    return; // Stop further execution
  }

  const [transportA, transportB] = InMemoryTransport.createLinkedPair();

  void startMcpGoogleMapServer(transportA, (params: MapParams) => {
    mapApp.handleMapQuery(params);
  });

  const mcpClient = await startClient(transportB);
  const aiChat = createAiChat(mcpClient, geminiApiKey);

  mapApp.sendMessageHandler = createSendMessageHandler(mapApp, aiChat);
});
