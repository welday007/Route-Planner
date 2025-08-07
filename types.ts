/**
 * Shared enumerations and interfaces for the Map application.
 */
export enum ChatState {
  IDLE,
  GENERATING,
  THINKING,
  EXECUTING,
}

export enum ChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

export interface ItineraryStop {
  name: string;
  hotelName?: string;
  address: string;
  accommodationCost?: number;
  location: any;
  marker: any;
  color: string;
  date?: string;
}

export interface ItineraryLeg {
  distanceText: string;
  distanceValue: number;
  durationText: string;
  fuelCost: number;
  polyline?: any;
  rawLegData: any;
  bounds: any;
  color: string;
}

export interface ItineraryData {
  stops: ItineraryStop[];
  legs: ItineraryLeg[];
  totalDistance: number;
  totalTime: string;
  totalFuelCost: number;
  totalAccommodationCost: number;
  totalTripDays?: number;
  travelMode: 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TRANSIT';
  bounds: any;
}

export interface TooltipInfo {
  content: string;
  top: number;
  left: number;
}

export interface MapView {
  id: number;
  name: string;
  center: {lat: number; lng: number; altitude: number};
  heading: number;
  tilt: number;
  range: number;
  type: 'stop' | 'leg' | 'custom';
  itineraryIndex: number;
}

