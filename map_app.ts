/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines the main `gdm-map-app` LitElement component.
 * This component is responsible for:
 * - Rendering the user interface, including the Google Photorealistic 3D Map,
 *   chat messages area, and user input field.
 * - Managing the state of the chat (e.g., idle, generating, thinking).
 * - Handling user input and sending messages to the Gemini AI model.
 * - Processing responses from the AI, including displaying text and handling
 *   function calls (tool usage) related to map interactions.
 * - Integrating with the Google Maps JavaScript API to load and control the map,
 *   display markers, polylines for routes, and geocode locations.
 * - Providing the `handleMapQuery` method, which is called by the MCP server
 *   (via index.tsx) to update the map based on AI tool invocations.
 */

// Google Maps JS API Loader: Used to load the Google Maps JavaScript API.
import {Loader} from '@googlemaps/js-api-loader';
import hljs from 'highlight.js';
import {html, LitElement, PropertyValueMap, nothing} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';
import {Marked} from 'marked';
import {markedHighlight} from 'marked-highlight';

import {MapParams} from './mcp_maps_server.js';
import {
  ICON_BUSY,
  ICON_CHEVRON_LEFT,
  ICON_CHEVRON_RIGHT,
  ICON_CHEVRON_UP,
  ICON_CHEVRON_DOWN,
  ICON_PLAY,
  ICON_STOP,
} from './icons.js';
import {
  ChatState,
  ChatRole,
  ItineraryStop,
  ItineraryLeg,
  ItineraryData,
  TooltipInfo,
  MapView,
} from './types.js';
import {
  USER_PROVIDED_GOOGLE_MAPS_API_KEY,
  DEFAULT_ITINERARY_JSON,
  EXAMPLE_PROMPTS,
  DEFAULT_GAS_PRICE_PER_GALLON,
  METERS_TO_MILES,
} from './constants.js';

export {ChatState, ChatRole};

/** Markdown formatting function with syntax hilighting */
export const marked = new Marked(
  markedHighlight({
    async: true,
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, {language}).value;
    },
  }),
);
/**
 * MapApp component for Photorealistic 3D Maps.
 */
@customElement('gdm-map-app')
export class MapApp extends LitElement {
  @query('#anchor') anchor?: HTMLDivElement;
  // Google Maps: Reference to the <gmp-map-3d> DOM element where the map is rendered.
  @query('#mapContainer') mapContainerElement?: HTMLElement; // Will be <gmp-map-3d>
  @query('#messageInput') messageInputElement?: HTMLInputElement;
  @query('#import-file-input') importFileInputElement?: HTMLInputElement;

  @state() chatState = ChatState.IDLE;
  @state() isRunning = true;
  @state() inputMessage = '';
  @state() messages: HTMLElement[] = [];
  @state() mapInitialized = false;
  @state() mapError = '';
  @state() private currentAnimationId = 0;
  @state() itineraryData: ItineraryData | null = null;
  @state() tooltipInfo: TooltipInfo | null = null;
  @state() private mpg = 20;
  @state() private animationSpeed = 75; // 0-100, where 100 is stopped
  @state() private isChatSidebarCollapsed = false;
  @state() private isItinerarySidebarCollapsed = false;
  @state() private isItinerarySummaryCollapsed = false;
  @state()
  private activeRightSidebarTab: 'itinerary' | 'tour' = 'itinerary';

  // Map Tour State
  @state() private savedViews: MapView[] = [];
  @state() private playbackDelay = 3;
  @state() private playbackFlyoverTime = 2; // New property for flyover time in seconds.
  @state() private loopTour = false;
  @state() private isPlayingTour = false;
  @state() private isSavingView = false;
  @state() private nextViewId = 0;
  @state() private draggedItemId: number | null = null;
  @state() private editingViewId: number | null = null;
  @state() private addStopsToTourToggle = false;
  @state() private addLegsToTourToggle = false;

  // UI State for sidebars
  @state() private loadTimestamp: Date;

  // Google Maps: Instance of the Google Maps 3D map.
  private map?: any;
  // Google Maps: Instance of the Google Maps Geocoding service.
  private geocoder?: any;
  // Google Maps: Instance of the current map marker (Marker3DElement).
  private marker?: any;

  // Google Maps: References to 3D map element constructors.
  private Map3DElement?: any;
  private Marker3DElement?: any;
  private Polyline3DElement?: any;

  // Google Maps: Instance of the Google Maps Directions service.
  private directionsService?: any;
  // Google Maps: Instance of the current route polylines.
  private routePolylines: any[] = [];
  // Google Maps: Markers for origin, destination, and waypoints of a route.
  private stopMarkers: any[] = [];
  // Google Maps: A single polyline for the gray background route in animations.
  private backgroundRoutePolyline?: any;

  private chatSidebarWidth = 400;
  private itinerarySidebarWidth = 400;

  sendMessageHandler?: CallableFunction;

  constructor() {
    super();
    // Start with an empty input field.
    this.inputMessage = '';
    this.loadTimestamp = new Date();
  }

  createRenderRoot() {
    return this;
  }

  protected firstUpdated(
    _changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>,
  ): void {
    // Google Maps: Load the map when the component is first updated.
    this.loadMap();
  }

  private _toggleChatSidebar() {
    this.isChatSidebarCollapsed = !this.isChatSidebarCollapsed;
  }

  private _toggleItinerarySidebar() {
    this.isItinerarySidebarCollapsed = !this.isItinerarySidebarCollapsed;
  }

  private _toggleItinerarySummary() {
    this.isItinerarySummaryCollapsed = !this.isItinerarySummaryCollapsed;
  }

  /**
   * Sets the input message to a new random prompt from EXAMPLE_PROMPTS.
   */
  private setNewRandomPrompt() {
    if (EXAMPLE_PROMPTS.length > 0) {
      this.inputMessage =
        EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    } else {
      this.inputMessage = '';
    }
  }

  /**
   * Google Maps: Loads the Google Maps JavaScript API using the JS API Loader.
   * It initializes necessary map services like Geocoding and Directions,
   * and imports 3D map elements (Map3DElement, Marker3DElement, Polyline3DElement).
   * Handles API key validation and error reporting.
   */
  async loadMap() {
    // The component will attempt to load the map with the hardcoded API key.
    // If the key is invalid or has billing issues, Google Maps will show an error overlay on the map.
    const loader = new Loader({
      apiKey: USER_PROVIDED_GOOGLE_MAPS_API_KEY,
      version: 'beta', // Using 'beta' for Photorealistic 3D Maps features
      libraries: ['geocoding', 'routes', 'geometry'], // Request necessary libraries
    });

    try {
      await loader.load();
      // Google Maps: Import 3D map specific library elements.
      const maps3dLibrary = await (window as any).google.maps.importLibrary(
        'maps3d',
      );
      this.Map3DElement = maps3dLibrary.Map3DElement;
      this.Marker3DElement = maps3dLibrary.Marker3DElement;
      this.Polyline3DElement = maps3dLibrary.Polyline3DElement;

      if ((window as any).google && (window as any).google.maps) {
        // Google Maps: Initialize the DirectionsService.
        this.directionsService = new (
          window as any
        ).google.maps.DirectionsService();
      } else {
        console.error('DirectionsService not loaded.');
      }

      // Google Maps: Initialize the map itself.
      this.initializeMap();
      this.mapInitialized = true;
      this.mapError = '';

      // Automatically process and display the default itinerary without adding to chat.
      const data = DEFAULT_ITINERARY_JSON;
      if (data && data.stops.length >= 2) {
        // For a trip with N stops, the tool expects N-1 accommodation costs (for stops 2..N).
        // The user's JSON has 15 stops and 14 accommodations. This matches.
        // We assume the accommodations array maps to stops 2 through 15.
        const accommodationCosts = data.accommodations.map(
          (a: any) => a.price_per_night,
        );
        const hotelNames = [
          '',
          ...data.accommodations.map((a: any) => a.hotel_name),
        ];

        await this.handleMapQuery({
          stops: data.stops,
          accommodationCosts,
          dates: data.dates,
          hotelNames,
        });
      }
    } catch (error) {
      console.error('Error loading Google Maps API:', error);
      this.mapError =
        'Could not load Google Maps. Check console for details. This might be due to an invalid or restricted API key.';
      this.mapInitialized = false;
    }
  }

  /**
   * Google Maps: Initializes the map instance and the Geocoder service.
   * This is called after the Google Maps API has been successfully loaded.
   */
  initializeMap() {
    if (!this.mapContainerElement || !this.Map3DElement) {
      console.error('Map container or Map3DElement class not ready.');
      return;
    }
    // Google Maps: Assign the <gmp-map-3d> element to the map property.
    this.map = this.mapContainerElement;
    if ((window as any).google && (window as any).google.maps) {
      // Google Maps: Initialize the Geocoder.
      this.geocoder = new (window as any).google.maps.Geocoder();
    } else {
      console.error('Geocoder not loaded.');
    }
  }

  setChatState(state: ChatState) {
    this.chatState = state;
  }

  /**
   * Google Maps: Clears existing map elements like markers and polylines
   * before adding new ones. This ensures the map doesn't get cluttered with
   * old search results or routes. It also invalidates any ongoing animations.
   */
  private _clearMapElements() {
    this.currentAnimationId++; // Invalidate previous animations
    if (this.marker) {
      this.marker.remove();
      this.marker = undefined;
    }
    this.routePolylines.forEach((line) => line.remove());
    this.routePolylines = [];
    this.stopMarkers.forEach((marker) => marker.remove());
    this.stopMarkers = [];
    if (this.backgroundRoutePolyline) {
      this.backgroundRoutePolyline.remove();
      this.backgroundRoutePolyline = undefined;
    }
    this.itineraryData = null; // Clear itinerary data
  }

  private _geocode(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.geocoder) {
        return reject(new Error('Geocoder not initialized.'));
      }
      this.geocoder.geocode(request, (results: any, status: string) => {
        if (status === 'OK') {
          resolve({results, status});
        } else {
          reject(new Error(`Geocode failed with status: ${status}`));
        }
      });
    });
  }

  /**
   * Google Maps: Handles viewing a specific location on the map.
   * It geocodes the location query to get coordinates, then flies the camera
   * to that location and places a 3D marker. The label for the marker is set
   * directly from the original query string.
   * @param locationQuery The string query for the location (e.g., "Eiffel Tower").
   */
  private async _handleViewLocation(locationQuery: string) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.geocoder ||
      !this.Marker3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready to display locations. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized, geocoder or Marker3DElement not available, cannot render query.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    try {
      const {results} = await this._geocode({address: locationQuery});
      if (results && results[0]) {
        const result = results[0];
        const location = result.geometry.location;

        // Google Maps: Define camera options and fly to the location.
        const cameraOptions = {
          center: {lat: location.lat(), lng: location.lng(), altitude: 0},
          heading: 0,
          tilt: 67.5,
          range: 2000, // Distance from the target in meters
        };
        (this.map as any).flyCameraTo({
          endCamera: cameraOptions,
          durationMillis: 1500,
        });

        // Google Maps: Create and add a 3D marker to the map.
        this.marker = new this.Marker3DElement();
        this.marker.position = {
          lat: location.lat(),
          lng: location.lng(),
          altitude: 0,
        };

        // Use the original locationQuery as the label, as requested.
        const label =
          locationQuery.length > 30
            ? locationQuery.substring(0, 27) + '...'
            : locationQuery;
        this.marker.label = label;
        (this.map as any).appendChild(this.marker);
      }
    } catch (error: any) {
      console.error(
        `Geocode was not successful for "${locationQuery}". Reason: ${error.message}`,
      );
      const rawErrorMessage = `Could not find location: ${locationQuery}. Reason: ${error.message}`;
      const {textElement} = this.addMessage('error', 'Processing error...');
      textElement.innerHTML = await marked.parse(rawErrorMessage);
    }
  }

  /**
   * Generates an array of color strings representing a spectrum from
   * green to blue to red.
   * @param steps The number of colors to generate (should match number of legs).
   * @returns An array of RGB color strings.
   */
  private _generateColorSpectrum(steps: number): string[] {
    if (steps <= 1) return ['rgb(0, 255, 0)']; // Green for a single leg

    const colors: string[] = [];
    const green = {r: 0, g: 255, b: 0};
    const blue = {r: 0, g: 0, b: 255};
    const red = {r: 255, g: 0, b: 0};

    const midPointIndex = Math.floor((steps - 1) / 2);

    // First half of the journey: Green to Blue
    for (let i = 0; i <= midPointIndex; i++) {
      const fraction = midPointIndex === 0 ? 1.0 : i / midPointIndex;
      const r = Math.round(green.r + (blue.r - green.r) * fraction);
      const g = Math.round(green.g + (blue.g - green.g) * fraction);
      const b = Math.round(green.b + (blue.b - green.b) * fraction);
      colors.push(`rgb(${r}, ${g}, ${b})`);
    }

    // Second half of the journey: Blue to Red
    const secondHalfSteps = steps - 1 - midPointIndex;
    for (let i = 1; i <= secondHalfSteps; i++) {
      const fraction = i / secondHalfSteps;
      const r = Math.round(blue.r + (red.r - blue.r) * fraction);
      const g = Math.round(blue.g + (red.g - blue.g) * fraction);
      const b = Math.round(blue.b + (red.b - blue.b) * fraction);
      colors.push(`rgb(${r}, ${g}, ${b})`);
    }

    return colors;
  }

  /**
   * Converts a CSS rgb color string to an object for the Maps API.
   * @param cssColor The color string, e.g., "rgb(255, 0, 0)".
   * @returns An object like { r: 255, g: 0, b: 0, a: 1 }.
   */
  private _cssColorToRgb(
    cssColor: string,
  ): {r: number; g: number; b: number; a: number} {
    const match = cssColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      return {
        r: parseInt(match[1], 10),
        g: parseInt(match[2], 10),
        b: parseInt(match[3], 10),
        a: 255, // The Maps API uses 0-255 for alpha
      };
    }
    // Fallback for solid colors
    return {r: 128, g: 128, b: 128, a: 255};
  }

  /**
   * Google Maps: Draws a single 3D polyline for one leg of a route.
   * @param leg The leg object from the DirectionsService response.
   * @param color The color for this leg's polyline.
   */
  private _drawLegPolyline(leg: any, color: string): any {
    if (!this.Polyline3DElement || !leg) return null;

    const legPolyline = new this.Polyline3DElement();
    const legPath = leg.steps.flatMap((step: any) =>
      step.path.map((p: any) => ({
        lat: p.lat(),
        lng: p.lng(),
        altitude: 5, // Render colored polylines slightly above the background
      })),
    );

    legPolyline.coordinates = legPath;
    legPolyline.strokeColor = color;
    legPolyline.strokeWidth = 10;
    (this.map as any).appendChild(legPolyline);
    this.routePolylines.push(legPolyline);
    return legPolyline;
  }

  private _startAnimation() {
    if (!this.itineraryData || !this.itineraryData.legs.length) return;

    const animationId = this.currentAnimationId;
    const speed = this.animationSpeed;
    // Should already be handled by _updateRouteAnimation, but as a safeguard:
    if (speed >= 100) {
      this._drawStaticRoute();
      return;
    }

    const legCount = this.itineraryData.legs.length;

    // 0% speed: 2s/leg. Total duration = 2000 * legCount
    const maxTotalDuration = 2000 * legCount;
    // 99% speed: 1s total. Total duration = 1000
    const minTotalDuration = 1000;

    // Linearly interpolate total duration for speed range [0, 99]
    const totalDuration =
      maxTotalDuration - (speed / 99) * (maxTotalDuration - minTotalDuration);

    const delayPerLeg = legCount > 0 ? totalDuration / legCount : 0;

    this._runAnimationLoop(animationId, this.itineraryData.legs, delayPerLeg);
  }

  private _stopAnimation() {
    this.currentAnimationId++; // Invalidate any running loops
    this._drawStaticRoute();
  }

  private _drawStaticRoute() {
    if (!this.itineraryData) return;

    this.routePolylines.forEach((line) => line.remove());
    this.routePolylines = [];

    this.itineraryData.legs.forEach((leg) => {
      const polyline = this._drawLegPolyline(leg.rawLegData, leg.color);
      if (polyline) {
        leg.polyline = polyline; // Update reference
        this._addPolylineTooltip(polyline, leg);
      }
    });
  }

  private _handleAnimationSpeedChange(e: Event) {
    this.animationSpeed = parseInt((e.target as HTMLInputElement).value, 10);
    this._updateRouteAnimation();
  }

  private _updateRouteAnimation() {
    if (!this.itineraryData) return;
    // Invalidate any old animation loop
    this.currentAnimationId++;
    if (this.animationSpeed === 100) {
      this._drawStaticRoute();
    } else {
      this._startAnimation();
    }
  }

  /**
   * Runs the route animation loop. Clears previous colored polylines,
   * then draws each new leg sequentially based on the calculated delay.
   * @param animationId The ID for this animation instance to prevent overlaps.
   * @param legsData The array of leg data from the itinerary.
   * @param delayPerLeg The time in ms to wait after drawing each leg.
   */
  private async _runAnimationLoop(
    animationId: number,
    legsData: ItineraryLeg[],
    delayPerLeg: number,
  ) {
    if (animationId !== this.currentAnimationId || this.animationSpeed === 100) {
      return;
    }

    // Clear only colored polylines from previous loop iteration
    this.routePolylines.forEach((line) => line.remove());
    this.routePolylines = [];

    // Color-in phase
    for (const leg of legsData) {
      if (animationId !== this.currentAnimationId || this.animationSpeed === 100)
        return;
      const polyline = this._drawLegPolyline(leg.rawLegData, leg.color);
      if (polyline) {
        leg.polyline = polyline; // Update polyline reference
        this._addPolylineTooltip(polyline, leg);
      }
      await new Promise((resolve) => setTimeout(resolve, delayPerLeg));
    }

    // Repeat the animation loop
    if (animationId === this.currentAnimationId && this.animationSpeed < 100) {
      this._runAnimationLoop(animationId, legsData, delayPerLeg);
    }
  }

  /**
   * Google Maps: Handles displaying directions between a series of stops.
   * This is a major function that calculates the route, processes all data for
   * the itinerary, and triggers the map drawing and animation.
   * @param stopsWithNames An array of strings representing the stops in the route.
   *        Each string can be a simple query, or a structured "name;;;query" string.
   * @param accommodationCosts An optional array of accommodation costs.
   * @param dates An optional array of dates for each stop.
   * @param travelMode The method of transport (e.g., 'DRIVING', 'WALKING').
   * @param hotelNames An optional array of hotel names for each stop.
   */
  private async _handleDirections(
    stopsWithNames: string[],
    accommodationCosts?: number[],
    dates?: string[],
    travelMode?: 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TRANSIT',
    hotelNames?: string[],
  ) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.directionsService ||
      !this.Marker3DElement ||
      !this.Polyline3DElement ||
      !this.geocoder
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready for directions. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized or required services not available, cannot render directions.',
      );
      return;
    }
    this._clearMapElements();
    const animationId = this.currentAnimationId; // Capture ID for this run.

    const stopQueries = stopsWithNames.map((s) =>
      s.includes(';;;') ? s.split(';;;')[1] : s,
    );
    const stopNames = stopsWithNames.map((s) =>
      s.includes(';;;') ? s.split(';;;')[0] : s,
    );

    const origin = stopQueries[0];
    const destination = stopQueries[stopQueries.length - 1];
    const waypoints = stopQueries.slice(1, -1).map((stop) => ({
      location: stop,
      stopover: true,
    }));
    const selectedTravelMode = travelMode || 'DRIVING';

    this.directionsService.route(
      {
        origin: origin,
        destination: destination,
        waypoints: waypoints,
        travelMode: (window as any).google.maps.TravelMode[selectedTravelMode],
      },
      async (response: any, status: string) => {
        if (animationId !== this.currentAnimationId) return; // Stale request

        if (
          status === 'OK' &&
          response &&
          response.routes &&
          response.routes.length > 0
        ) {
          const route = response.routes[0];
          const spectrumColors = this._generateColorSpectrum(route.legs.length);

          // --- Build Itinerary Data ---
          const newItineraryData: ItineraryData = {
            stops: [],
            legs: [],
            totalDistance: route.legs.reduce(
              (sum: number, leg: any) => sum + leg.distance.value,
              0,
            ),
            totalTime: this._formatTotalDuration(
              route.legs.reduce(
                (sum: number, leg: any) => sum + leg.duration.value,
                0,
              ),
            ),
            totalFuelCost: 0, // Will be calculated below
            totalAccommodationCost: accommodationCosts
              ? accommodationCosts.reduce((sum, cost) => sum + cost, 0)
              : 0,
            totalTripDays: this._calculateTripDays(dates),
            travelMode: selectedTravelMode,
            bounds: route.bounds,
          };

          // --- Process Stops and Legs ---
          if (route.legs && route.legs.length > 0 && this.Marker3DElement) {
            // Process Origin Stop
            const originLocation = route.legs[0].start_location;
            const originMarker = new this.Marker3DElement();
            const originColor = spectrumColors[0];
            originMarker.position = originLocation;
            originMarker.label = `1: ${stopNames[0]}`;
            originMarker.style = {color: this._cssColorToRgb(originColor)};
            (this.map as any).appendChild(originMarker);
            this.stopMarkers.push(originMarker);
            const originStop: ItineraryStop = {
              name: stopNames[0],
              hotelName: hotelNames?.[0],
              address: route.legs[0].start_address,
              location: originLocation,
              marker: originMarker,
              color: originColor,
              date: dates?.[0],
            };
            newItineraryData.stops.push(originStop);
            this._addMarkerTooltip(originMarker, originStop);

            // Process Waypoints, Destination Stops & All Legs
            route.legs.forEach((leg: any, index: number) => {
              const legColor = spectrumColors[index];
              const stopLocation = leg.end_location;
              const stopMarker = new this.Marker3DElement();
              stopMarker.position = stopLocation;
              stopMarker.label = `${index + 2}: ${stopNames[index + 1]}`;
              stopMarker.style = {color: this._cssColorToRgb(legColor)};
              (this.map as any).appendChild(stopMarker);
              this.stopMarkers.push(stopMarker);

              const destStop: ItineraryStop = {
                name: stopNames[index + 1],
                hotelName: hotelNames?.[index + 1],
                address: leg.end_address,
                accommodationCost: accommodationCosts?.[index],
                location: stopLocation,
                marker: stopMarker,
                color: legColor,
                date: dates?.[index + 1],
              };
              newItineraryData.stops.push(destStop);
              this._addMarkerTooltip(stopMarker, destStop);

              const distanceMiles = leg.distance.value * METERS_TO_MILES;
              const fuelCost =
                selectedTravelMode === 'DRIVING'
                  ? (distanceMiles / this.mpg) * DEFAULT_GAS_PRICE_PER_GALLON
                  : 0;

              const legBounds = new (window as any).google.maps.LatLngBounds();
              leg.steps.forEach((step: any) => {
                step.path.forEach((p: any) => legBounds.extend(p));
              });

              newItineraryData.legs.push({
                distanceText: leg.distance.text,
                distanceValue: leg.distance.value,
                durationText: leg.duration.text,
                fuelCost: fuelCost,
                rawLegData: leg,
                bounds: legBounds, // Use corrected bounds
                color: legColor,
              });
              newItineraryData.totalFuelCost += fuelCost;
            });
          }
          this.itineraryData = newItineraryData;

          this._zoomToBounds(route.bounds);

          // Draw gray background polyline for animation
          const fullPath = route.legs.flatMap((leg: any) =>
            leg.steps.flatMap((step: any) => step.path),
          );
          this.backgroundRoutePolyline = new this.Polyline3DElement();
          this.backgroundRoutePolyline.coordinates = fullPath;
          this.backgroundRoutePolyline.strokeColor = '#B0B0B0';
          this.backgroundRoutePolyline.strokeWidth = 10;
          (this.map as any).appendChild(this.backgroundRoutePolyline);

          // Start animation or draw static route based on slider state
          this._updateRouteAnimation();
        } else {
          console.error(
            `Directions request failed for stops: "${stopNames.join(
              ', ',
            )}". Status: ${status}.`,
          );
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(
            `Could not get directions. Reason: ${status}`,
          );
        }
      },
    );
  }

  private _formatTotalDuration(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / (3600 * 24));
    totalSeconds %= 3600 * 24;
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);

    let result = '';
    if (days > 0) result += `${days} day${days > 1 ? 's' : ''} `;
    if (hours > 0) result += `${hours} hour${hours > 1 ? 's' : ''} `;
    if (minutes > 0) result += `${minutes} min${minutes > 1 ? 's' : ''}`;
    return result.trim();
  }

  private _calculateTripDays(dates?: string[]): number | undefined {
    if (!dates || dates.length < 2) {
      return undefined;
    }
    try {
      const startDate = new Date(dates[0]);
      const endDate = new Date(dates[dates.length - 1]);
      // Add 1 to include both start and end days
      const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
      return diffDays;
    } catch (e) {
      console.error('Error parsing dates for trip duration:', e);
      return undefined;
    }
  }

  private _zoomToBounds(bounds: any) {
    if (!bounds) return;
    const center = bounds.getCenter();
    let range = 10000;
    if (
      (window as any).google.maps.geometry &&
      (window as any).google.maps.geometry.spherical
    ) {
      const spherical = (window as any).google.maps.geometry.spherical;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      range = spherical.computeDistanceBetween(ne, sw) * 1.7;
    }
    range = Math.max(range, 2000);
    (this.map as any).flyCameraTo({
      endCamera: {
        center: {lat: center.lat(), lng: center.lng(), altitude: 0},
        heading: 0,
        tilt: 45,
        range: range,
      },
      durationMillis: 2000,
    });
  }

  private _addMarkerTooltip(marker: any, stop: ItineraryStop) {
    marker.addEventListener('mouseover', (e: MouseEvent) => {
      const hotelText = stop.hotelName ? `<br><i>${stop.hotelName}</i>` : '';
      const showAddress =
        stop.address &&
        !stop.address.toLowerCase().includes(stop.name.toLowerCase());
      const costText = stop.accommodationCost
        ? ` <br> <b>Lodging:</b> $${stop.accommodationCost.toFixed(2)}`
        : '';
      const dateText = stop.date ? ` <br> <b>Date:</b> ${stop.date}` : '';
      const addressText = showAddress
        ? `<br><small style="opacity: 0.8">${stop.address}</small>`
        : '';
      this._showTooltip(
        `<b>${stop.name}</b>${hotelText}${dateText}${costText}${addressText}`,
        e,
      );
    });
    marker.addEventListener('mouseout', () => this._hideTooltip());
  }

  private _addPolylineTooltip(polyline: any, leg: ItineraryLeg) {
    polyline.addEventListener('mouseover', (e: MouseEvent) => {
      // Find the most up-to-date leg data from the state, as it might have
      // changed (e.g., fuel cost recalculation).
      const currentLeg =
        this.itineraryData?.legs.find(
          (l) => l.rawLegData === leg.rawLegData,
        ) ?? leg; // Fallback to original data.
      const fuelCostText =
        this.itineraryData?.travelMode === 'DRIVING'
          ? ` <br> <b>Fuel Cost:</b> $${currentLeg.fuelCost.toFixed(2)}`
          : '';

      this._showTooltip(
        `<b>Distance:</b> ${currentLeg.distanceText} <br> <b>Time:</b> ${currentLeg.durationText}${fuelCostText}`,
        e,
      );
    });
    polyline.addEventListener('mouseout', () => this._hideTooltip());
  }

  private _showTooltip(content: string, event: MouseEvent) {
    this.tooltipInfo = {
      content,
      top: event.clientY + 15,
      left: event.clientX + 15,
    };
  }
  private _hideTooltip() {
    this.tooltipInfo = null;
  }
  private _zoomToLeg(leg: ItineraryLeg) {
    if (leg.bounds) {
      this._zoomToBounds(leg.bounds);
    }
  }
  private _zoomToStop(stop: ItineraryStop) {
    (this.map as any).flyCameraTo({
      endCamera: {
        center: {
          lat: stop.location.lat(),
          lng: stop.location.lng(),
          altitude: 0,
        },
        heading: 0,
        tilt: 67.5,
        range: 2000,
      },
      durationMillis: 1500,
    });
  }

  private _recalculateFuelCosts() {
    if (!this.itineraryData || this.itineraryData.travelMode !== 'DRIVING') {
      return;
    }

    let totalFuelCost = 0;
    const updatedLegs = this.itineraryData.legs.map((leg) => {
      const distanceMiles = leg.distanceValue * METERS_TO_MILES;
      const newFuelCost =
        this.mpg > 0
          ? (distanceMiles / this.mpg) * DEFAULT_GAS_PRICE_PER_GALLON
          : 0;
      totalFuelCost += newFuelCost;
      return {...leg, fuelCost: newFuelCost};
    });

    this.itineraryData = {
      ...this.itineraryData,
      legs: updatedLegs,
      totalFuelCost: totalFuelCost,
    };
  }

  private _highlightLeg(legToHighlight: ItineraryLeg) {
    if (this.animationSpeed < 100) return; // Only highlight when static
    this.itineraryData?.legs.forEach((leg) => {
      if (leg.polyline) {
        if (leg === legToHighlight) {
          leg.polyline.strokeColor = leg.color;
        } else {
          leg.polyline.strokeColor = '#CCCCCC'; // Light gray
        }
      }
    });
  }

  private _highlightAdjacentLegs(stopIndex: number) {
    if (!this.itineraryData || this.animationSpeed < 100) return;

    const arrivingLegIndex = stopIndex - 1;
    const departingLegIndex = stopIndex;

    this.itineraryData.legs.forEach((leg, index) => {
      if (leg.polyline) {
        if (index === arrivingLegIndex || index === departingLegIndex) {
          leg.polyline.strokeColor = leg.color;
        } else {
          leg.polyline.strokeColor = '#CCCCCC'; // Light gray
        }
      }
    });
  }

  private _unhighlightLegs() {
    if (this.animationSpeed < 100) return;
    this.itineraryData?.legs.forEach((leg) => {
      if (leg.polyline) {
        leg.polyline.strokeColor = leg.color;
      }
    });
  }

  /**
   * Google Maps: This function is the primary interface for the MCP server (via index.tsx)
   * to trigger updates on the Google Map.
   * @param params An object containing parameters for the map query.
   */
  async handleMapQuery(params: MapParams) {
    if (params.location) {
      await this._handleViewLocation(params.location);
    } else if (params.stops && params.stops.length >= 2) {
      this.activeRightSidebarTab = 'itinerary';
      await this._handleDirections(
        params.stops,
        params.accommodationCosts,
        params.dates,
        params.travelMode,
        params.hotelNames,
      );
    }
  }

  setInputField(message: string) {
    this.inputMessage = message.trim();
  }

  addMessage(role: string, message: string) {
    const div = document.createElement('div');
    div.classList.add('turn');
    div.classList.add(`role-${role.trim()}`);
    div.setAttribute('aria-live', 'polite');

    const thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking process';
    thinkingDetails.classList.add('thinking');
    thinkingDetails.setAttribute('aria-label', 'Model thinking process');
    const thinkingElement = document.createElement('div');
    thinkingDetails.append(summary);
    thinkingDetails.append(thinkingElement);
    div.append(thinkingDetails);

    const textElement = document.createElement('div');
    textElement.className = 'text';
    textElement.innerHTML = message;
    div.append(textElement);

    this.messages = [...this.messages, div];
    this.scrollToTheEnd();
    return {
      thinkingContainer: thinkingDetails,
      thinkingElement: thinkingElement,
      textElement: textElement,
    };
  }

  scrollToTheEnd() {
    if (!this.anchor) return;
    this.anchor.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }

  async sendMessageAction(message?: string, role?: string) {
    if (this.chatState !== ChatState.IDLE) return;

    let msg = '';

    if (message) {
      // Message is provided programmatically
      msg = message.trim();
    } else {
      // Message from the UI input field
      msg = this.inputMessage.trim();
      // Clear the input field state only if we are using its content
      // and there was actual content to send.
      if (msg.length > 0) {
        this.inputMessage = '';
      } else if (
        this.inputMessage.trim().length === 0 &&
        this.inputMessage.length > 0
      ) {
        // If inputMessage contained only whitespace, clear it.
        this.inputMessage = '';
      }
    }

    if (msg.length === 0) {
      return;
    }

    // --- Itinerary Table Parsing Logic ---
    const parsedItinerary = this._parseItineraryTable(msg);
    if (parsedItinerary && parsedItinerary.stops.length >= 2) {
      // It's an itinerary table. Handle it directly without sending to the AI.
      const {textElement} = this.addMessage('user', '...');
      textElement.innerHTML = await marked.parse(msg);

      if (this.sendMessageHandler) {
        this.setChatState(ChatState.EXECUTING);
        const {textElement: assistantText} = this.addMessage('assistant', '');
        assistantText.innerHTML = await marked.parse(
          'Got it. Plotting this trip for you now...',
        );

        // Call the map handler directly with the parsed data
        await this.handleMapQuery({
          stops: parsedItinerary.stops,
          accommodationCosts: parsedItinerary.accommodationCosts,
          dates: parsedItinerary.dates,
        });

        this.setChatState(ChatState.IDLE);
      }
      return; // End processing for this message.
    }
    // --- End of Itinerary Table Parsing ---

    const msgRole = role ? role.toLowerCase() : 'user';

    // Add user's message to the chat display
    if (msgRole === 'user' && msg) {
      const {textElement} = this.addMessage(msgRole, '...');
      textElement.innerHTML = await marked.parse(msg);
    }

    // Send the message via the handler (to AI)
    if (this.sendMessageHandler) {
      await this.sendMessageHandler(msg, msgRole);
    }
  }

  private async inputKeyDownAction(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessageAction();
    }
  }

  /**
   * Parses a markdown table representing a trip itinerary.
   * @param markdown The raw markdown string from the user input.
   * @returns A structured object with stops, dates, and costs, or null if parsing fails.
   */
  private _parseItineraryTable(
    markdown: string,
  ): {stops: string[]; dates: string[]; accommodationCosts: number[]} | null {
    const lines = markdown
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Basic check for markdown table structure
    if (
      lines.length < 3 ||
      !lines[0].includes('|') ||
      !lines[1].includes('--')
    ) {
      return null;
    }

    const dataRows = lines.slice(2);
    const stops: string[] = []; // Will store "name;;;query"
    const dates: string[] = [];
    const rates: number[] = [];

    const year = new Date().getFullYear();

    for (const row of dataRows) {
      if (!row.startsWith('|')) continue;
      const columns = row.split('|').map((c) => c.trim());
      if (columns.length < 8) continue;

      // Column 3: Stop Name (for labels)
      const stopNameForLabel = columns[3]
        .replace(/\*\*|– START|– RETURN/g, '')
        .trim();

      // Create a more specific query for geocoding
      const address = columns[4];
      let query = '';
      if (address && address !== '—') {
        query = stopNameForLabel.includes('Home')
          ? address
          : `${stopNameForLabel}, ${address}`;
      } else {
        query = stopNameForLabel;
      }
      stops.push(`${stopNameForLabel};;;${query}`);

      // Column 2: Dates
      const dateStr = columns[2];
      if (dateStr && dateStr !== '—') {
        try {
          // Handle "Aug 12" and "Aug 13–14" - take the first date.
          const firstDatePart = dateStr.split(/–|-/)[0].trim();
          const date = new Date(`${firstDatePart} ${year}`);
          if (!isNaN(date.getTime())) {
            dates.push(date.toISOString().split('T')[0]);
          } else {
            dates.push(''); // Push empty if parsing fails
          }
        } catch (e) {
          console.error('Date parsing error:', e);
          dates.push('');
        }
      } else {
        dates.push('');
      }

      // Column 7: Rate
      const rateStr = columns[7];
      if (rateStr && rateStr !== '—') {
        const rate = parseFloat(rateStr.replace(/[$\\]/g, ''));
        rates.push(isNaN(rate) ? 0 : rate);
      } else {
        rates.push(0);
      }
    }

    if (stops.length < 2) {
      return null; // Not a valid itinerary for directions
    }

    // The tool expects N-1 accommodation costs for N stops (from 2nd stop onwards)
    const accommodationCosts = rates.slice(1);

    return {
      stops,
      dates,
      accommodationCosts,
    };
  }

  private _onResizeMouseDown(
    e: MouseEvent,
    sidebarId: 'chat-sidebar' | 'itinerary-sidebar',
  ) {
    e.preventDefault();
    const sidebar = this.renderRoot.querySelector<HTMLElement>(`#${sidebarId}`)!;
    if (!sidebar || sidebar.classList.contains('collapsed')) {
      return;
    }

    const startX = e.clientX;
    const startWidth = sidebar.clientWidth;
    const isLeftSidebar = sidebarId === 'chat-sidebar';

    const onMouseMove = (moveEvent: MouseEvent) => {
      document.body.style.cursor = 'col-resize';
      const deltaX = moveEvent.clientX - startX;
      let newWidth = isLeftSidebar ? startWidth + deltaX : startWidth - deltaX;

      const minWidth = 200;
      const maxWidth = window.innerWidth / 2;

      newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));

      sidebar.style.width = `${newWidth}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Persist width for future re-renders
      if (isLeftSidebar) {
        this.chatSidebarWidth = sidebar.clientWidth;
      } else {
        this.itinerarySidebarWidth = sidebar.clientWidth;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.userSelect = 'none';
  }

  // =================================================================
  // MAP TOUR FEATURE LOGIC
  // =================================================================

  private _getViewForStop(stop: ItineraryStop) {
    return {
      center: {
        lat: stop.location.lat(),
        lng: stop.location.lng(),
        altitude: 0,
      },
      heading: 0,
      tilt: 67.5,
      range: 2000,
    };
  }

  private _getViewForLeg(leg: ItineraryLeg) {
    const bounds = leg.bounds;
    const center = bounds.getCenter();
    let range = 10000;
    if (
      (window as any).google.maps.geometry &&
      (window as any).google.maps.geometry.spherical
    ) {
      const spherical = (window as any).google.maps.geometry.spherical;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      range = spherical.computeDistanceBetween(ne, sw) * 1.7;
    }
    range = Math.max(range, 2000); // Ensure a minimum range

    return {
      center: {lat: center.lat(), lng: center.lng(), altitude: 0},
      heading: 0,
      tilt: 45,
      range: range,
    };
  }

  private _addFromItineraryToTour() {
    if (!this.itineraryData) return;
    if (!this.addStopsToTourToggle && !this.addLegsToTourToggle) return;

    const viewsToAdd: MapView[] = [];

    if (this.addStopsToTourToggle) {
      const stopViews = this.itineraryData.stops.map((stop, index) => {
        const viewParams = this._getViewForStop(stop);
        return {
          ...viewParams,
          id: this.nextViewId++,
          name: stop.name,
          type: 'stop' as const,
          itineraryIndex: index * 2,
        };
      });
      viewsToAdd.push(...stopViews);
    }

    if (this.addLegsToTourToggle) {
      const legViews = this.itineraryData.legs.map((leg, index) => {
        const viewParams = this._getViewForLeg(leg);
        return {
          ...viewParams,
          id: this.nextViewId++,
          name: `Leg: ${this.itineraryData!.stops[index].name} → ${
            this.itineraryData!.stops[index + 1].name
          }`,
          type: 'leg' as const,
          itineraryIndex: index * 2 + 1,
        };
      });
      viewsToAdd.push(...legViews);
    }

    // If both were added in this action, sort them to mix them correctly
    if (this.addStopsToTourToggle && this.addLegsToTourToggle) {
      viewsToAdd.sort((a, b) => a.itineraryIndex - b.itineraryIndex);
    }

    this.savedViews = [...this.savedViews, ...viewsToAdd];

    // Reset toggles after adding
    this.addStopsToTourToggle = false;
    this.addLegsToTourToggle = false;
  }

  private flyToView(view: MapView, durationMillis = 1500) {
    if (!this.map) return;
    (this.map as any).flyCameraTo({
      endCamera: {
        center: view.center,
        heading: view.heading,
        tilt: view.tilt,
        range: view.range,
      },
      durationMillis,
    });
  }

  private async saveCurrentView() {
    if (!this.map || this.isSavingView) return;
    this.isSavingView = true;

    try {
      const cameraState = (this.map as any).cameraState;
      if (!cameraState) {
        throw new Error('Map camera state is not available.');
      }
      const {center, heading, tilt, range} = cameraState;

      let name = `View @ ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`;

      // Reverse geocode to get a better name
      if (this.geocoder) {
        try {
          // Pass only lat/lng to geocoder, as it expects a LatLng or LatLngLiteral.
          const {results} = await this._geocode({
            location: {lat: center.lat, lng: center.lng},
          });
          if (results && results[0]) {
            name = results[0].formatted_address;
          }
        } catch (e) {
          console.warn(
            'Reverse geocoding failed, using coordinates as name.',
            e,
          );
        }
      }

      const newView: MapView = {
        id: this.nextViewId++,
        name,
        center,
        heading,
        tilt,
        range,
        type: 'custom',
        itineraryIndex: -1,
      };

      this.savedViews = [...this.savedViews, newView];
    } catch (e) {
      console.error('Failed to save view:', e);
      alert('Error: Could not save the current view.');
    } finally {
      this.isSavingView = false;
    }
  }

  private _clearTourViews() {
    if (this.savedViews.length === 0) return;
    this.savedViews = [];
    this.nextViewId = 0;
    this.isPlayingTour = false;
  }

  private async playTour() {
    if (this.isPlayingTour || this.savedViews.length === 0) return;
    this.isPlayingTour = true;

    while (this.isPlayingTour) {
      for (const view of this.savedViews) {
        if (!this.isPlayingTour) break;

        const flyoverMillis = this.playbackFlyoverTime * 1000;

        // Use a variable animation duration for flying
        this.flyToView(view, flyoverMillis);
        await new Promise((resolve) => setTimeout(resolve, flyoverMillis));

        if (!this.isPlayingTour) break;

        // Wait for playbackDelay
        await new Promise((resolve) =>
          setTimeout(resolve, this.playbackDelay * 1000),
        );
      }

      if (!this.loopTour) {
        break; // Exit while loop if not looping
      }
    }

    this.isPlayingTour = false;
  }

  private deleteView(idToDelete: number) {
    this.savedViews = this.savedViews.filter((view) => view.id !== idToDelete);
  }

  private startEditingView(id: number) {
    if (this.isPlayingTour) return;
    this.editingViewId = id;
  }

  private handleRenameKeyDown(e: KeyboardEvent, id: number) {
    if (e.key === 'Enter') {
      this.saveViewName(id, (e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      this.editingViewId = null;
    }
  }

  private saveViewName(id: number, newName: string) {
    if (this.editingViewId !== id) return;

    const viewIndex = this.savedViews.findIndex((v) => v.id === id);
    if (viewIndex > -1 && newName.trim()) {
      const updatedViews = [...this.savedViews];
      updatedViews[viewIndex] = {
        ...updatedViews[viewIndex],
        name: newName.trim(),
      };
      this.savedViews = updatedViews;
    }
    this.editingViewId = null;
  }

  private handleDragStart(event: DragEvent, view: MapView) {
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Set data for cross-browser compatibility.
      event.dataTransfer.setData('text/plain', String(view.id));
    }
    this.draggedItemId = view.id;
    // Use currentTarget to ensure we are targeting the `li` element itself.
    (event.currentTarget as HTMLElement).classList.add('dragging');
  }

  private handleDrop(event: DragEvent, dropTargetView: MapView) {
    event.preventDefault();
    if (this.draggedItemId === null || this.draggedItemId === dropTargetView.id) {
      return;
    }

    const draggedIndex = this.savedViews.findIndex(
      (v) => v.id === this.draggedItemId,
    );
    const targetIndex = this.savedViews.findIndex(
      (v) => v.id === dropTargetView.id,
    );

    if (draggedIndex === -1 || targetIndex === -1) return;

    const reorderedViews = [...this.savedViews];
    const [draggedItem] = reorderedViews.splice(draggedIndex, 1);
    reorderedViews.splice(targetIndex, 0, draggedItem);

    this.savedViews = reorderedViews;
  }

  private handleDragEnd(event: DragEvent) {
    this.draggedItemId = null;
    // Since createRenderRoot() returns `this`, there's no shadowRoot.
    // Query the element's light DOM to find and remove the dragging class.
    const draggingElement = this.querySelector('.tour-view-item.dragging');
    if (draggingElement) {
      draggingElement.classList.remove('dragging');
    }
  }

  private exportTour() {
    if (this.savedViews.length === 0) return;

    const tourData = {
      playbackDelay: this.playbackDelay,
      playbackFlyoverTime: this.playbackFlyoverTime,
      loopTour: this.loopTour,
      views: this.savedViews,
    };

    const dataStr = JSON.stringify(tourData, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'map-tour.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private importTour() {
    this.importFileInputElement?.click();
  }

  private validateTourFile(data: any): boolean {
    if (typeof data !== 'object' || data === null) return false;
    if (typeof data.playbackDelay !== 'number') return false;
    if (
      data.playbackFlyoverTime !== undefined &&
      typeof data.playbackFlyoverTime !== 'number'
    )
      return false;
    if (typeof data.loopTour !== 'boolean') return false;
    if (!Array.isArray(data.views)) return false;

    for (const view of data.views) {
      if (typeof view.id !== 'number') return false;
      if (typeof view.name !== 'string') return false;
      if (typeof view.heading !== 'number') return false;
      if (typeof view.tilt !== 'number') return false;
      if (typeof view.range !== 'number') return false;
      if (typeof view.center !== 'object' || view.center === null) return false;
      if (typeof view.center.lat !== 'number') return false;
      if (typeof view.center.lng !== 'number') return false;
      // altitude can be optional in some older exports
      if (
        view.center.altitude !== undefined &&
        typeof view.center.altitude !== 'number'
      )
        return false;
    }
    return true;
  }

  private handleFileImport(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        if (!this.validateTourFile(data)) {
          throw new Error('Invalid or corrupted tour file format.');
        }

        if (
          this.savedViews.length > 0 &&
          !confirm(
            'This will replace your current tour. Are you sure you want to continue?',
          )
        ) {
          return;
        }

        this.playbackDelay = data.playbackDelay;
        this.playbackFlyoverTime = data.playbackFlyoverTime ?? 2;
        this.loopTour = data.loopTour;
        this.savedViews = data.views;
        this.nextViewId =
          Math.max(...data.views.map((v: MapView) => v.id), 0) + 1;
        this.activeRightSidebarTab = 'tour';
        alert('Tour imported successfully!');
      } catch (error: any) {
        console.error('Error importing tour file:', error);
        alert(`Failed to import tour: ${error.message}`);
      } finally {
        // Reset file input to allow re-importing the same file
        input.value = '';
      }
    };

    reader.onerror = () => {
      alert('Error reading the selected file.');
      input.value = '';
    };

    reader.readAsText(file);
  }

  // =================================================================
  // RENDER METHODS
  // =================================================================

  private renderItineraryPanel() {
    if (!this.itineraryData) {
      return html` <div class="itinerary-placeholder">
        Plan a route with multiple stops to see a trip itinerary here.
      </div>`;
    }

    const {
      stops,
      legs,
      totalDistance,
      totalTime,
      totalFuelCost,
      totalAccommodationCost,
      totalTripDays,
      travelMode,
    } = this.itineraryData;
    const totalCost = totalFuelCost + totalAccommodationCost;

    return html`
      <div id="itinerary-panel">
        <div
          class="itinerary-summary ${classMap({
            collapsed: this.isItinerarySummaryCollapsed,
          })}">
          <h3>
            <span>Trip Summary</span>
            <button
              class="collapse-summary-button"
              @click=${this._toggleItinerarySummary}
              title=${this.isItinerarySummaryCollapsed
                ? 'Expand summary'
                : 'Collapse summary'}>
              ${this.isItinerarySummaryCollapsed
                ? ICON_CHEVRON_DOWN
                : ICON_CHEVRON_UP}
            </button>
          </h3>
          ${this.isItinerarySummaryCollapsed
            ? nothing
            : html` <div class="summary-grid">
                <div class="summary-item">
                  <span class="label">Total Distance</span>
                  <span class="value"
                    >${(totalDistance * METERS_TO_MILES).toFixed(1)} mi</span
                  >
                </div>
                <div class="summary-item">
                  <span class="label">Travel Time</span>
                  <span class="value">${totalTime}</span>
                </div>
                ${travelMode === 'DRIVING'
                  ? html`<div class="summary-item">
                      <span class="label">Fuel Cost</span>
                      <span class="value">$${totalFuelCost.toFixed(2)}</span>
                    </div>`
                  : nothing}
                <div class="summary-item">
                  <span class="label">Lodging Cost</span>
                  <span class="value"
                    >$${totalAccommodationCost.toFixed(2)}</span
                  >
                </div>
                <div class="summary-item">
                  <span class="label">Total Cost</span>
                  <span class="value">$${totalCost.toFixed(2)}</span>
                </div>
                ${totalTripDays
                  ? html`<div class="summary-item">
                      <span class="label">Trip Duration</span>
                      <span class="value"
                        >${totalTripDays} day${totalTripDays > 1
                          ? 's'
                          : ''}</span
                      >
                    </div>`
                  : nothing}
              </div>`}
        </div>

        ${this.isItinerarySummaryCollapsed
          ? nothing
          : html` <div class="itinerary-controls">
              ${travelMode === 'DRIVING'
                ? html`<div class="control-group">
                    <label for="mpgInput">Vehicle MPG:</label>
                    <input
                      type="number"
                      id="mpgInput"
                      .value=${this.mpg}
                      @input=${(e: Event) => {
                        this.mpg =
                          parseFloat((e.target as HTMLInputElement).value) || 0;
                        this._recalculateFuelCosts();
                      }} />
                  </div>`
                : html`<div class="control-group">
                    <label>Travel Mode:</label>
                    <strong style="text-transform: capitalize;"
                      >${travelMode.toLowerCase()}</strong
                    >
                  </div>`}
              <div class="control-group">
                <label for="animationSpeedSlider">Anim. Speed:</label>
                <input
                  type="range"
                  id="animationSpeedSlider"
                  min="0"
                  max="100"
                  .value=${this.animationSpeed}
                  @input=${this._handleAnimationSpeedChange} />
              </div>
              <button
                @click=${() => this._zoomToBounds(this.itineraryData?.bounds)}>
                View Entire Route
              </button>
            </div>`}

        <div class="itinerary-content">
          <ul class="itinerary-list">
            ${stops.map((stop, index) => {
              const leg = index > 0 ? legs[index - 1] : null;
              return html`
                ${leg
                  ? html`<li
                      class="itinerary-leg"
                      style=${styleMap({'border-left-color': leg.color})}
                      @click=${() => this._zoomToLeg(leg)}
                      @mouseover=${(e: MouseEvent) => {
                        const currentLeg =
                          this.itineraryData?.legs.find(
                            (l) => l.rawLegData === leg.rawLegData,
                          ) ?? leg;
                        const fuelCostText =
                          this.itineraryData?.travelMode === 'DRIVING'
                            ? ` <br> <b>Fuel Cost:</b> $${currentLeg.fuelCost.toFixed(
                                2,
                              )}`
                            : '';
                        this._showTooltip(
                          `<b>Distance:</b> ${currentLeg.distanceText} <br> <b>Time:</b> ${currentLeg.durationText}${fuelCostText}`,
                          e,
                        );
                        this._highlightLeg(leg);
                      }}
                      @mouseout=${() => {
                        this._hideTooltip();
                        this._unhighlightLegs();
                      }}>
                      <h3>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          height="24px"
                          viewBox="0 -960 960 960"
                          width="24px">
                          <path
                            d="M598-132 553-177l109-109H320v-60h342L553-455l45-45 188 188-188 180Z" />
                          <path
                            d="M480-240q-100 0-170-70t-70-170q0-100 70-170t170-70q100 0 170 70t70 170q0 100-70 170t-170 70Zm0-60q75 0 127.5-52.5T660-480q0-75-52.5-127.5T480-660q-75 0-127.5 52.5T300-480q0 75 52.5 127.5T480-300Z" />
                        </svg>
                        <span class="leg-route"
                          >${stops[index - 1].name} → ${stop.name}</span
                        >
                      </h3>
                      <div class="itinerary-details">
                        <span class="detail-item">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            height="24px"
                            viewBox="0 -960 960 960"
                            width="24px">
                            <path
                              d="m612-532-57-57 65-65-65-65 57-57 122 122-122 122ZM480-120q-150 0-255-105T120-480q0-150 105-255t255-105q150 0 255 105t105 255q0 150-105 255T480-120Zm0-60q125 0 212.5-87.5T780-480q0-125-87.5-212.5T480-780q-125 0-212.5 87.5T180-480q0 125 87.5 212.5T480-180Zm0-300Z" />
                          </svg>
                          ${leg.distanceText}
                        </span>
                        <span class="detail-item">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            height="24px"
                            viewBox="0 -960 960 960"
                            width="24px">
                            <path
                              d="M480-80q-83 0-155.5-31.5T197-197q-54-54-85.5-126.5T80-480q0-83 31.5-155.5T197-763q54-54 126.5-85.5T480-880q83 0 155.5 31.5T763-763q54 54 85.5 126.5T880-480q0 83-31.5 155.5T763-197q-54 54-126.5 85.5T480-80Zm0-400Zm0 340q142 0 241-99t99-241q0-142-99-241t-241-99q-142 0-241 99t-99 241q0 142 99 241t241 99Zm-20-220h80v-160h-80v160Zm20 80q21 0 35.5-14.5T530-160q0-21-14.5-35.5T480-210q-21 0-35.5 14.5T430-160q0 21 14.5 35.5T480-110Z" />
                          </svg>
                          ${leg.durationText}
                        </span>
                        ${travelMode === 'DRIVING'
                          ? html`<span class="detail-item">
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                height="24px"
                                viewBox="0 -960 960 960"
                                width="24px">
                                <path
                                  d="M296-120q-27.56 0-48.78-21.22T226-190q0-27.56 21.22-48.78T296-260h368q27.56 0 48.78 21.22T734-190q0 27.56-21.22 48.78T664-120H296Zm-68-180-28-112q-3-14 4.88-26.5T226-460h508q15.23 0 25.12 11.5T764-422l-28 112q-5 18-20.5 29t-33.5 11H320q-18 0-33.5-11t-20.5-29ZM320-520h320q17 0 28.5-11.5T680-560v-240q0-17-11.5-28.5T640-840H320q-17 0-28.5 11.5T280-800v240q0 17 11.5 28.5T320-520Z" />
                              </svg>
                              $${leg.fuelCost.toFixed(2)}
                            </span>`
                          : nothing}
                      </div>
                    </li>`
                  : nothing}
                <li
                  class="itinerary-stop"
                  style=${styleMap({'border-left-color': stop.color})}
                  @click=${() => this._zoomToStop(stop)}
                  @mouseover=${(e: MouseEvent) => {
                    this._highlightAdjacentLegs(index);
                    const hotelText = stop.hotelName
                      ? `<br><i>${stop.hotelName}</i>`
                      : '';
                    const showAddress =
                      stop.address &&
                      !stop.address
                        .toLowerCase()
                        .includes(stop.name.toLowerCase());
                    const costText = stop.accommodationCost
                      ? ` <br> <b>Lodging:</b> $${stop.accommodationCost.toFixed(
                          2,
                        )}`
                      : '';
                    const dateText = stop.date
                      ? ` <br> <b>Date:</b> ${stop.date}`
                      : '';
                    const addressText = showAddress
                      ? `<br><small style="opacity: 0.8">${stop.address}</small>`
                      : '';
                    this._showTooltip(
                      `<b>${stop.name}</b>${hotelText}${dateText}${costText}${addressText}`,
                      e,
                    );
                  }}
                  @mouseout=${() => {
                    this._unhighlightLegs();
                    this._hideTooltip();
                  }}>
                  <h3>
                    <span class="stop-name">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        height="24px"
                        viewBox="0 -960 960 960"
                        width="24px">
                        <path
                          d="M480-480q33 0 56.5-23.5T560-560q0-33-23.5-56.5T480-640q-33 0-56.5 23.5T400-560q0 33 23.5 56.5T480-480Zm0 294q122-112 181-203.5T720-552q0-109-68.5-178.5T480-800q-103 0-171.5 69.5T240-552q0-71 59-162.5T480-186Zm0 86q-186-166-263-291.5T140-552q0-141 99.5-238.5T480-880q141 0 240.5 97.5T820-552q0-111-77-236.5T480-100Z" />
                      </svg>
                      ${index === 0
                        ? 'Origin'
                        : index === stops.length - 1
                          ? 'Destination'
                          : `Stop ${index + 1}`}
                    </span>
                    ${stop.date
                      ? html`<span class="stop-date">${stop.date}</span>`
                      : nothing}
                  </h3>
                  <div>
                    <strong>${stop.name}</strong>
                    ${stop.hotelName
                      ? html`<div class="stop-hotel-name">
                          ${stop.hotelName}
                        </div>`
                      : nothing}
                    ${stop.address &&
                    !stop.address
                      .toLowerCase()
                      .includes(stop.name.toLowerCase())
                      ? html`<div class="stop-address">${stop.address}</div>`
                      : nothing}
                  </div>
                  ${stop.accommodationCost
                    ? html`<div
                        class="itinerary-details"
                        style="margin-top: 8px;">
                        <span class="detail-item">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            height="24px"
                            viewBox="0 -960 960 960"
                            width="24px">
                            <path
                              d="M440-400h80v-120h120v-80H520v-120h-80v120H320v80h120v120ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Z" />
                          </svg>
                          $${stop.accommodationCost.toFixed(2)}
                        </span>
                      </div>`
                    : nothing}
                </li>
              `;
            })}
          </ul>
        </div>
        <div class="itinerary-footer">
          <div class="code-timestamp">
            Last updated: ${this.loadTimestamp.toLocaleString()}
          </div>
        </div>
      </div>
    `;
  }

  private renderTourPanel() {
    return html`
      <div class="tour-controls">
        <input
          id="import-file-input"
          type="file"
          class="hidden"
          @change=${this.handleFileImport}
          accept=".json" />

        <h4>Map Tour</h4>
        <div class="tour-actions">
          <div class="tour-buttons">
            <button
              @click=${this.saveCurrentView}
              ?disabled=${this.isSavingView || this.isPlayingTour}
              title="Save the current map camera position as a new view in the tour.">
              ${this.isSavingView ? 'Saving...' : 'Save View'}
            </button>
            <button
              @click=${this.importTour}
              ?disabled=${this.isPlayingTour}
              title="Import a tour from a .json file.">
              Import
            </button>
            <button
              @click=${this.exportTour}
              ?disabled=${this.savedViews.length < 1 || this.isPlayingTour}
              title="Export the current tour to a .json file.">
              Export
            </button>
            <button
              @click=${this._clearTourViews}
              ?disabled=${this.savedViews.length < 1 || this.isPlayingTour}
              title="Delete all saved views from the tour.">
              Clear
            </button>
          </div>

          <div
            class="tour-itinerary-actions"
            title=${!this.itineraryData
              ? 'An itinerary must be present to add stops or legs.'
              : ''}>
            <span>Add from Itinerary:</span>
            <div class="tour-itinerary-toggles">
              <div class="tour-loop-toggle">
                <label for="stops-toggle">Stops</label>
                <label class="switch">
                  <input
                    id="stops-toggle"
                    type="checkbox"
                    .checked=${this.addStopsToTourToggle}
                    @change=${(e: InputEvent) =>
                      (this.addStopsToTourToggle = (
                        e.target as HTMLInputElement
                      ).checked)}
                    ?disabled=${!this.itineraryData || this.isPlayingTour} />
                  <span class="slider round"></span>
                </label>
              </div>
              <div class="tour-loop-toggle">
                <label for="legs-toggle">Legs</label>
                <label class="switch">
                  <input
                    id="legs-toggle"
                    type="checkbox"
                    .checked=${this.addLegsToTourToggle}
                    @change=${(e: InputEvent) =>
                      (this.addLegsToTourToggle = (
                        e.target as HTMLInputElement
                      ).checked)}
                    ?disabled=${!this.itineraryData || this.isPlayingTour} />
                  <span class="slider round"></span>
                </label>
              </div>
              <button
                @click=${this._addFromItineraryToTour}
                ?disabled=${!this.itineraryData ||
                this.isPlayingTour ||
                (!this.addStopsToTourToggle && !this.addLegsToTourToggle)}>
                Add
              </button>
            </div>
          </div>

          <div class="tour-settings">
            <div class="tour-playback-controls">
              <button
                @click=${this.playTour}
                ?disabled=${this.isPlayingTour || this.savedViews.length < 1}
                title="Play the sequence of saved views.">
                ${ICON_PLAY}
              </button>
              <button
                @click=${() => (this.isPlayingTour = false)}
                ?disabled=${!this.isPlayingTour}
                title="Stop the current tour playback.">
                ${ICON_STOP}
              </button>
            </div>
            <div class="tour-options-group">
              <div class="tour-delay">
                <label for="flyover-input">Flyover</label>
                <input
                  id="flyover-input"
                  type="number"
                  min="0.5"
                  step="0.5"
                  .value=${this.playbackFlyoverTime}
                  @input=${(e: InputEvent) =>
                    (this.playbackFlyoverTime = Number(
                      (e.target as HTMLInputElement).value,
                    ))} />
                <span>s</span>
              </div>
              <div class="tour-delay">
                <label for="delay-input">Delay</label>
                <input
                  id="delay-input"
                  type="number"
                  min="0"
                  step="0.5"
                  .value=${this.playbackDelay}
                  @input=${(e: InputEvent) =>
                    (this.playbackDelay = Number(
                      (e.target as HTMLInputElement).value,
                    ))} />
                <span>s</span>
              </div>
              <div class="tour-loop-toggle">
                <label for="loop-toggle">Loop</label>
                <label class="switch">
                  <input
                    id="loop-toggle"
                    type="checkbox"
                    .checked=${this.loopTour}
                    @change=${(e: InputEvent) =>
                      (this.loopTour = (
                        e.target as HTMLInputElement
                      ).checked)} />
                  <span class="slider round"></span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <ul class="tour-views-list">
          ${this.savedViews.map(
            (view) => html`
              <li
                class="tour-view-item"
                draggable="true"
                @click=${() => {
                  if (this.editingViewId !== view.id) {
                    this.flyToView(view);
                  }
                }}
                @dragstart=${(e: DragEvent) => this.handleDragStart(e, view)}
                @drop=${(e: DragEvent) => this.handleDrop(e, view)}
                @dragover=${(e: DragEvent) => e.preventDefault()}
                @dragend=${this.handleDragEnd}>
                ${
                  this.editingViewId === view.id
                    ? html`<input
                        class="view-item-name-input"
                        .value=${view.name}
                        @keydown=${(e: KeyboardEvent) =>
                          this.handleRenameKeyDown(e, view.id)}
                        @blur=${(e: FocusEvent) =>
                          this.saveViewName(
                            view.id,
                            (e.target as HTMLInputElement).value,
                          )}
                        @click=${(e: Event) => e.stopPropagation()}
                        autofocus />`
                    : html`<span
                        class="view-item-name"
                        title="Double-click to rename"
                        @dblclick=${() => this.startEditingView(view.id)}
                        >${view.name}</span
                      >`
                }
                <button
                  class="view-item-delete-btn"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    this.deleteView(view.id);
                  }}
                  title="Delete this view">
                  ×
                </button>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }

  private renderRightSidebar() {
    return html`
      <button
        class="collapse-button"
        @click=${this._toggleItinerarySidebar}
        title=${this.isItinerarySidebarCollapsed
          ? 'Expand sidebar'
          : 'Collapse sidebar'}>
        ${this.isItinerarySidebarCollapsed
          ? ICON_CHEVRON_LEFT
          : ICON_CHEVRON_RIGHT}
      </button>
      <div class="sidebar-content">
        <div class="sidebar-tabs">
          <button
            class=${classMap({
              active: this.activeRightSidebarTab === 'itinerary',
            })}
            @click=${() => (this.activeRightSidebarTab = 'itinerary')}>
            Itinerary
          </button>
          <button
            class=${classMap({active: this.activeRightSidebarTab === 'tour'})}
            @click=${() => (this.activeRightSidebarTab = 'tour')}>
            Map Tour
          </button>
        </div>
        ${this.activeRightSidebarTab === 'itinerary'
          ? html`
              <h2 id="itinerary-heading" class="sr-only">Itinerary</h2>
              ${this.renderItineraryPanel()}
            `
          : html`
              <h2 id="tour-heading" class="sr-only">Map Tour</h2>
              ${this.renderTourPanel()}
            `}
      </div>
    `;
  }

  render() {
    // Google Maps: Initial camera parameters for the <gmp-map-3d> element.
    const initialCenter = '39.82, -98.58, 100'; // Centered on USA
    const initialRange = '5000000'; // Zoomed to show continental USA
    const initialTilt = '45'; // Camera tilt in degrees
    const initialHeading = '0'; // Camera heading in degrees

    const tooltipStyles = this.tooltipInfo
      ? {
          top: `${this.tooltipInfo.top}px`,
          left: `${this.tooltipInfo.left}px`,
        }
      : {};

    const chatSidebarStyles = {
      width: `${this.chatSidebarWidth}px`,
    };

    const itinerarySidebarStyles = {
      width: `${this.itinerarySidebarWidth}px`,
    };

    return html`<div class="gdm-map-app">
      <div
        id="chat-sidebar"
        class=${classMap({
          sidebar: true,
          collapsed: this.isChatSidebarCollapsed,
        })}
        style=${styleMap(chatSidebarStyles)}>
        <button
          class="collapse-button"
          @click=${this._toggleChatSidebar}
          title=${this.isChatSidebarCollapsed
            ? 'Expand sidebar'
            : 'Collapse sidebar'}>
          ${this.isChatSidebarCollapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_LEFT}
        </button>
        <div class="sidebar-content">
          <h2 id="chat-heading">Travel Agent</h2>
          <div id="chat-panel">
            <div class="chat-messages" aria-live="polite" aria-atomic="false">
              ${this.messages}
              <div id="anchor"></div>
            </div>
            <div class="footer">
              <div
                id="chatStatus"
                aria-live="assertive"
                class=${classMap({hidden: this.chatState === ChatState.IDLE})}>
                ${this.chatState === ChatState.GENERATING
                  ? html`${ICON_BUSY} Generating...`
                  : html``}
                ${this.chatState === ChatState.THINKING
                  ? html`${ICON_BUSY} Thinking...`
                  : html``}
                ${this.chatState === ChatState.EXECUTING
                  ? html`${ICON_BUSY} Executing...`
                  : html``}
              </div>
              <div
                id="inputArea"
                role="form"
                aria-labelledby="message-input-label">
                <label id="message-input-label" class="hidden"
                  >Type your message</label
                >
                <textarea
                  id="messageInput"
                  .value=${this.inputMessage}
                  @input=${(e: InputEvent) => {
                    this.inputMessage = (
                      e.target as HTMLTextAreaElement
                    ).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    this.inputKeyDownAction(e);
                  }}
                  placeholder="Type your message..."
                  autocomplete="off"
                  aria-labelledby="message-input-label"
                  aria-describedby="sendButton-desc"
                  rows="4"></textarea>
                <button
                  id="sendButton"
                  @click=${() => {
                    this.sendMessageAction();
                  }}
                  aria-label="Send message"
                  aria-describedby="sendButton-desc"
                  ?disabled=${this.chatState !== ChatState.IDLE}
                  class=${classMap({
                    disabled: this.chatState !== ChatState.IDLE,
                  })}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    height="30px"
                    viewBox="0 -960 960 960"
                    width="30px"
                    fill="currentColor"
                    aria-hidden="true">
                    <path
                      d="M120-160v-240l320-80-320-80v-240l760 320-760 320Z" />
                  </svg>
                </button>
                <p id="sendButton-desc" class="hidden">
                  Sends the typed message to the AI.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        class="resizer"
        id="chat-resizer"
        ?hidden=${this.isChatSidebarCollapsed}
        @mousedown=${(e: MouseEvent) =>
          this._onResizeMouseDown(e, 'chat-sidebar')}></div>
      <div
        class="main-container"
        role="application"
        aria-label="Interactive Map Area">
        ${this.tooltipInfo
          ? html`<div
              class="map-tooltip"
              style=${styleMap(tooltipStyles)}
              role="tooltip"
              .innerHTML=${this.tooltipInfo.content}></div>`
          : nothing}
        ${this.mapError
          ? html`<div
              class="map-error-message"
              role="alert"
              aria-live="assertive"
              .innerHTML=${this.mapError}></div>`
          : ''}
        <!-- Google Maps: The core 3D Map custom element -->
        <gmp-map-3d
          id="mapContainer"
          style="height: 100%; width: 100%;"
          aria-label="Google Photorealistic 3D Map Display"
          mode="hybrid"
          center="${initialCenter}"
          heading="${initialHeading}"
          tilt="${initialTilt}"
          range="${initialRange}"
          default-ui-disabled="true"
          role="application">
        </gmp-map-3d>
      </div>
      <div
        class="resizer"
        id="itinerary-resizer"
        ?hidden=${this.isItinerarySidebarCollapsed}
        @mousedown=${(e: MouseEvent) =>
          this._onResizeMouseDown(e, 'itinerary-sidebar')}></div>
      <div
        id="itinerary-sidebar"
        class=${classMap({
          sidebar: true,
          collapsed: this.isItinerarySidebarCollapsed,
        })}
        style=${styleMap(itinerarySidebarStyles)}>
        ${this.renderRightSidebar()}
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-map-app': MapApp;
  }
}
