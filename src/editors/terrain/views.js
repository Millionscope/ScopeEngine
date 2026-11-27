/**
 * Terrain view per city (same order as the globe's CITIES): camera zoom and terrain exaggeration.
 * Flat cities (Amsterdam, Dubai, Bangkok…) get a wider view and more exaggeration so relief shows;
 * mountain cities (Mexico City, Los Angeles, Seoul…) pull back to frame the ranges around them.
 * @module editors/terrain/views
 */
export const VIEWS = {
  London: { zoom: 10.2, exag: 7 },
  'New York City': { zoom: 10.4, exag: 6 },
  Paris: { zoom: 10.3, exag: 6 },
  Tokyo: { zoom: 9.2, exag: 2.4 },
  Madrid: { zoom: 9.2, exag: 2.6 },
  Singapore: { zoom: 10.8, exag: 8 },
  Rome: { zoom: 9.6, exag: 3 },
  Dubai: { zoom: 9.4, exag: 7 },
  Berlin: { zoom: 10.2, exag: 9 },
  Barcelona: { zoom: 10.2, exag: 2.4 },
  Sydney: { zoom: 9, exag: 2.6 },
  'Los Angeles': { zoom: 9.6, exag: 1.8 },
  Seoul: { zoom: 10.4, exag: 2 },
  Amsterdam: { zoom: 10.4, exag: 14 },
  Melbourne: { zoom: 9.4, exag: 3 },
  Bangkok: { zoom: 10.2, exag: 14 },
  Shanghai: { zoom: 10, exag: 12 },
  Istanbul: { zoom: 10.2, exag: 3.5 },
  'Mexico City': { zoom: 9.2, exag: 1.6 },
  Lisbon: { zoom: 10, exag: 3 },
};
