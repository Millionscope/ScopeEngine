/**
 * Tour stops: city centre (WGS84, decimal degrees) and the Natural Earth ADM0_A3 code of its country.
 * ADM0_A3, not ISO_A3: Natural Earth has France's ISO codes as -99.
 * @module editors/shared/cities
 */
export const CITIES = [
  { name: 'London', country: 'United Kingdom', a3: 'GBR', lat: 51.5074, lng: -0.1278 },
  { name: 'New York City', country: 'United States', a3: 'USA', lat: 40.7128, lng: -74.006 },
  { name: 'Paris', country: 'France', a3: 'FRA', lat: 48.8566, lng: 2.3522 },
  { name: 'Tokyo', country: 'Japan', a3: 'JPN', lat: 35.6762, lng: 139.6503 },
  { name: 'Madrid', country: 'Spain', a3: 'ESP', lat: 40.4168, lng: -3.7038 },
  { name: 'Singapore', country: 'Singapore', a3: 'SGP', lat: 1.3521, lng: 103.8198 },
  { name: 'Rome', country: 'Italy', a3: 'ITA', lat: 41.9028, lng: 12.4964 },
  { name: 'Dubai', country: 'United Arab Emirates', a3: 'ARE', lat: 25.2048, lng: 55.2708 },
  { name: 'Berlin', country: 'Germany', a3: 'DEU', lat: 52.52, lng: 13.405 },
  { name: 'Barcelona', country: 'Spain', a3: 'ESP', lat: 41.3874, lng: 2.1686 },
  { name: 'Sydney', country: 'Australia', a3: 'AUS', lat: -33.8688, lng: 151.2093 },
  { name: 'Los Angeles', country: 'United States', a3: 'USA', lat: 34.0522, lng: -118.2437 },
  { name: 'Seoul', country: 'South Korea', a3: 'KOR', lat: 37.5665, lng: 126.978 },
  { name: 'Amsterdam', country: 'Netherlands', a3: 'NLD', lat: 52.3676, lng: 4.9041 },
  { name: 'Melbourne', country: 'Australia', a3: 'AUS', lat: -37.8136, lng: 144.9631 },
  { name: 'Bangkok', country: 'Thailand', a3: 'THA', lat: 13.7563, lng: 100.5018 },
  { name: 'Shanghai', country: 'China', a3: 'CHN', lat: 31.2304, lng: 121.4737 },
  { name: 'Istanbul', country: 'Türkiye', a3: 'TUR', lat: 41.0082, lng: 28.9784 },
  { name: 'Mexico City', country: 'Mexico', a3: 'MEX', lat: 19.4326, lng: -99.1332 },
  { name: 'Lisbon', country: 'Portugal', a3: 'PRT', lat: 38.7223, lng: -9.1393 },
];

export const COUNTRIES_URL = '/geo/countries-50m.json';

/** 51.5074, -0.1278 → "51.5074° N · 0.1278° W" */
export const fmtLatLng = (lat, lng) => `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'} · ${Math.abs(lng).toFixed(4)}° ${lng < 0 ? 'W' : 'E'}`;
