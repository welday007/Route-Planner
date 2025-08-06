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

import {GoogleGenAI, mcpToTool} from '@google/genai';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {ChatState, MapApp, marked} from './map_app.js'; // Updated import path

import {MapParams, startMcpGoogleMapServer} from './mcp_maps_server.js';

/* --------- */

async function startClient(transport: Transport) {
  const client = new Client({name: 'AI Studio', version: '1.0.0'});
  await client.connect(transport);
  return client;
}

/* ------------ */

const SYSTEM_INSTRUCTIONS = `You are an expert cartographer and travel guide, highly proficient with maps and discovering interesting places.
Your primary goal is to assist users by displaying relevant information on the interactive map and building a detailed trip itinerary using the available tools.

Tool Usage Guidelines:
1.  **Identify Specific Locations First:** Before using any map tool, you MUST first determine a specific, concrete place name, address, or well-known landmark for each stop.
    *   **GOOD Example:** User asks "Where is the southernmost town?" You think: "The southernmost permanently inhabited settlement is Puerto Williams, Chile." Then you call 'view_location_google_maps' with the query parameter: "Puerto Williams, Chile".
    *   **BAD Example:** User asks "Where is the southernmost town?" You call 'view_location_google_maps' with the query parameter: "southernmost town". This is too vague.
    *   **what3words:** If the user provides a what3words address (e.g., ///filled.count.soap), you must convert it into a standard place name or address (e.g., "Statue of Liberty") before using that name in a tool. Do NOT try to create what3words addresses.

2.  **Building a Directions Itinerary ('directions_on_google_maps'):**
    *   **Gather All Information:** When a user asks for directions, you must ask clarifying questions to gather ALL of the following information before calling the tool:
        1. The date for EACH stop.
        2. The accommodation cost per night for EACH stop (excluding the origin).
        3. The name of the hotel or lodging for each stop where applicable.
    *   The user will set their vehicle's MPG in the UI, so you do not need to ask for it.
    *   **Provide Stop Details:**
        *   'stops': A list of two or more specific, recognizable place names or addresses.
        *   'hotelNames': (Optional) An array of hotel or lodging names. The order must match the 'stops' array. Use an empty string for stops that are not hotels.
        *   'dates': An array of dates (e.g., "YYYY-MM-DD"). The number of dates must match the number of stops.
        *   'accommodationCosts': An array of accommodation costs. The order must match the order of the stops, starting from the *second* stop (the first destination). For a 3-stop trip (A to B to C), this array should contain two numbers: [cost_for_B, cost_for_C].
        *   'travelMode': (Optional) The method of transportation. Can be 'DRIVING', 'WALKING', 'BICYCLING', or 'TRANSIT'. If not specified, it defaults to 'DRIVING'. It is crucial to select an appropriate mode. For example, for requests within cities known for being pedestrian-friendly or having extensive public transport (like Venice, Italy), you **MUST** use 'WALKING' or 'TRANSIT' to get a valid route, as 'DRIVING' will fail.
    *   **Route Animation:** The route animation is controlled by the user via an "Animate" checkbox in the UI. You do not control the animation.

3.  **Explain Your Actions:** After identifying a place and before (or as part of) calling a tool, clearly explain what location you are about to show or what directions you are providing. For example: "Okay, I'll show you Puerto Williams, Chile."

4.  **Concise Text for Map Actions:** When a tool displays something on the map, you don't need to state that you are doing it. The map action itself is sufficient. Instead, after the tool action, you can provide extra interesting facts or context about the location or route.

5.  **If unsure, ask for clarification:** If a user's request is too vague to identify a specific place for the map tools, ask for more details instead of making a tool call with vague parameters.`;

function createAiChat(mcpClient: Client, geminiApiKey: string) {
  const ai = new GoogleGenAI({
    apiKey: geminiApiKey,
  });
  return ai.chats.create({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
      tools: [mcpToTool(mcpClient)],
    },
  });
}

function camelCaseToDash(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

document.addEventListener('DOMContentLoaded', async (event) => {
  const rootElement = document.querySelector('#root')! as HTMLElement;

  const mapApp = document.createElement('gdm-map-app') as MapApp & HTMLElement;
  // The Google Maps API key is now managed within the map_app component.
  rootElement.appendChild(mapApp);

  const geminiApiKey = process.env.API_KEY;

  if (!geminiApiKey) {
    const errorMessage = await marked.parse(
      '**Configuration Error:** The Gemini API Key is missing. Please add `API_KEY=YOUR_KEY_HERE` to your `.env` file to enable the chat. You may need to restart the server after creating the file.',
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

  mapApp.sendMessageHandler = async (input: string, role: string) => {
    console.log('sendMessageHandler', input, role);

    const {thinkingElement, textElement, thinkingContainer} = mapApp.addMessage(
      'assistant',
      '',
    );

    mapApp.setChatState(ChatState.GENERATING);
    textElement.innerHTML = '...'; // Initial placeholder

    let newCode = '';
    let thoughtAccumulator = '';

    try {
      // Outer try for overall message handling including post-processing
      try {
        // Inner try for AI interaction and message parsing
        const stream = await aiChat.sendMessageStream({message: input});

        for await (const chunk of stream) {
          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.functionCall) {
                console.log(
                  'FUNCTION CALL:',
                  part.functionCall.name,
                  part.functionCall.args,
                );
                const mcpCall = {
                  name: camelCaseToDash(part.functionCall.name!),
                  arguments: part.functionCall.args,
                };

                const explanation =
                  'Calling function:\n```json\n' +
                  JSON.stringify(mcpCall, null, 2) +
                  '\n```';
                const {textElement: functionCallText} = mapApp.addMessage(
                  'assistant',
                  '',
                );
                functionCallText.innerHTML = await marked.parse(explanation);
              }

              if (part.thought) {
                mapApp.setChatState(ChatState.THINKING);
                thoughtAccumulator += ' ' + part.thought;
                thinkingElement.innerHTML =
                  await marked.parse(thoughtAccumulator);
                if (thinkingContainer) {
                  thinkingContainer.classList.remove('hidden');
                  thinkingContainer.setAttribute('open', 'true');
                }
              } else if (part.text) {
                mapApp.setChatState(ChatState.EXECUTING);
                newCode += part.text;
                textElement.innerHTML = await marked.parse(newCode);
              }
              mapApp.scrollToTheEnd();
            }
          }
        }
      } catch (e: unknown) {
        // Catch for AI interaction errors.
        console.error('GenAI SDK Error:', e);
        let baseErrorText: string;

        if (e instanceof Error) {
          baseErrorText = e.message;
        } else if (typeof e === 'string') {
          baseErrorText = e;
        } else if (
          e &&
          typeof e === 'object' &&
          'message' in e &&
          typeof (e as {message: unknown}).message === 'string'
        ) {
          baseErrorText = (e as {message: string}).message;
        } else {
          try {
            // Attempt to stringify complex objects, otherwise, simple String conversion.
            baseErrorText = `Unexpected error: ${JSON.stringify(e)}`;
          } catch (stringifyError) {
            baseErrorText = `Unexpected error: ${String(e)}`;
          }
        }

        let finalErrorMessage = baseErrorText; // Start with the extracted/formatted base error message.

        // Attempt to parse a JSON object from the baseErrorText, as some SDK errors embed details this way.
        // This is useful if baseErrorText itself is a string containing JSON.
        const jsonStartIndex = baseErrorText.indexOf('{');
        const jsonEndIndex = baseErrorText.lastIndexOf('}');

        if (jsonStartIndex > -1 && jsonEndIndex > jsonStartIndex) {
          const potentialJson = baseErrorText.substring(
            jsonStartIndex,
            jsonEndIndex + 1,
          );
          try {
            const sdkError = JSON.parse(potentialJson);
            let refinedMessageFromSdkJson: string | undefined;

            // Check for common nested error structures (e.g., sdkError.error.message)
            // or a direct message (sdkError.message) in the parsed JSON.
            if (
              sdkError &&
              typeof sdkError === 'object' &&
              sdkError.error && // Check if 'error' property exists and is truthy
              typeof sdkError.error === 'object' && // Check if 'error' property is an object
              typeof sdkError.error.message === 'string' // Check for 'message' string within 'error' object
            ) {
              refinedMessageFromSdkJson = sdkError.error.message;
            } else if (
              sdkError &&
              typeof sdkError === 'object' && // Check if sdkError itself is an object
              typeof sdkError.message === 'string' // Check for a direct 'message' string on sdkError
            ) {
              refinedMessageFromSdkJson = sdkError.message;
            }

            if (refinedMessageFromSdkJson) {
              finalErrorMessage = refinedMessageFromSdkJson; // Update if JSON parsing yielded a more specific message
            }
          } catch (parseError) {
            // If parsing fails, finalErrorMessage remains baseErrorText.
            console.warn(
              'Could not parse potential JSON from error message; using base error text.',
              parseError,
            );
          }
        }

        const {textElement: errorTextElement} = mapApp.addMessage('error', '');
        errorTextElement.innerHTML = await marked.parse(
          `Error: ${finalErrorMessage}`,
        );
      }

      // Post-processing logic (now inside the outer try)
      if (thinkingContainer && thinkingContainer.hasAttribute('open')) {
        if (!thoughtAccumulator) {
          thinkingContainer.classList.add('hidden');
        }
        thinkingContainer.removeAttribute('open');
      }

      if (
        textElement.innerHTML.trim() === '...' ||
        textElement.innerHTML.trim().length === 0
      ) {
        const hasFunctionCallMessage = mapApp.messages.some((el) =>
          el.innerHTML.includes('Calling function:'),
        );
        if (!hasFunctionCallMessage) {
          textElement.innerHTML = await marked.parse('Done.');
        } else if (textElement.innerHTML.trim() === '...') {
          textElement.innerHTML = '';
        }
      }
    } finally {
      // Finally for the outer try, ensures chat state is reset
      mapApp.setChatState(ChatState.IDLE);
    }
  };
});
