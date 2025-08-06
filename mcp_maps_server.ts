/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines and runs an MCP (Model Context Protocol) server.
 * The server exposes tools that an AI model (like Gemini) can call to interact
 * with Google Maps functionality. These tools include:
 * - `view_location_google_maps`: To display a specific location.
 * - `directions_on_google_maps`: To get and display directions.
 *
 * When the AI decides to use one of these tools, the MCP server receives the
 * call and then uses the `mapQueryHandler` callback to send the relevant
 * parameters (location, origin/destination) to the frontend
 * (MapApp component in map_app.ts) to update the map display.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';

export interface MapParams {
  location?: string;
  stops?: string[];
  legColors?: string[];
  accommodationCosts?: number[];
  dates?: string[];
  travelMode?: 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TRANSIT';
  hotelNames?: string[];
}

export async function startMcpGoogleMapServer(
  transport: Transport,
  /**
   * Callback function provided by the frontend (index.tsx) to handle map updates.
   * This function is invoked when an AI tool call requires a map interaction,
   * passing the necessary parameters to update the map view (e.g., show location,
   * display directions). It is the bridge between MCP server tool execution and
   * the visual map representation in the MapApp component.
   */
  mapQueryHandler: (params: MapParams) => void,
) {
  // Create an MCP server
  const server = new McpServer({
    name: 'AI Studio Google Map',
    version: '1.0.0',
  });

  server.tool(
    'view_location_google_maps',
    'View a specific query or geographical location and display in the embedded maps interface. Use the most specific name or address provided by the user for the label.',
    {query: z.string()},
    async ({query}) => {
      mapQueryHandler({location: query});
      return {
        content: [{type: 'text', text: `Navigating to: ${query}`}],
      };
    },
  );

  server.tool(
    'directions_on_google_maps',
    'Search Google Maps for directions between a series of stops to generate a route and a detailed itinerary. Provide at least two stops. Ask the user for dates, accommodation costs, and hotel names for each stop (except the origin) before calling this tool. The vehicle MPG and route animation are set in the UI.',
    {
      stops: z
        .array(z.string())
        .min(2, {message: 'Must provide at least two stops for directions.'}),
      hotelNames: z
        .array(z.string())
        .optional()
        .describe(
          'An array of hotel or lodging names. The order must match the stops. Use an empty string for stops that are not hotels. E.g., for stops A->Hotel B->C, this could be ["", "Hilton Garden Inn", ""].',
        ),
      accommodationCosts: z
        .array(z.number())
        .optional()
        .describe(
          'An array of accommodation costs per night. The order must match the stops, starting from the second stop. E.g., for stops A->B->C, this should be [cost_for_B, cost_for_C].',
        ),
      dates: z
        .array(z.string())
        .optional()
        .describe(
          'An array of dates for each stop (e.g., "YYYY-MM-DD"). The number of dates must match the number of stops.',
        ),
      travelMode: z
        .enum(['DRIVING', 'WALKING', 'BICYCLING', 'TRANSIT'])
        .optional()
        .describe(
          "The method of transportation. Defaults to 'DRIVING'. Use 'WALKING' or 'TRANSIT' for dense cities or islands where driving is not possible, like Venice.",
        ),
    },
    async ({stops, accommodationCosts, dates, travelMode, hotelNames}) => {
      mapQueryHandler({
        stops,
        accommodationCosts,
        dates,
        travelMode,
        hotelNames,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Calculating directions and itinerary for stops: ${stops.join(
              ' -> ',
            )}`,
          },
        ],
      };
    },
  );

  await server.connect(transport);
  console.log('server running');
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
