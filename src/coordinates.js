/**
 * Coordinate conversion utilities.
 * Convert between lat/lon and local feet coordinate system using Mercator projection.
 */

const FEET_PER_METER = 3.28084;

/**
 * Get the meters-per-degree at a given latitude.
 */
export function metersPerDegreeLat() {
  return 111320; // approximately constant
}

export function metersPerDegreeLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Convert a feet offset from an origin lat/lon back to lat/lon.
 * @param {number} originLat
 * @param {number} originLon
 * @param {number} xFeet - east offset in feet
 * @param {number} yFeet - north offset in feet
 * @returns {[number, number]} [lon, lat] in Mapbox format
 */
export function feetToLatLon(originLat, originLon, xFeet, yFeet) {
  const xMeters = xFeet / FEET_PER_METER;
  const yMeters = yFeet / FEET_PER_METER;
  
  const lat = originLat + yMeters / metersPerDegreeLat();
  const lon = originLon + xMeters / metersPerDegreeLon(originLat);
  
  return [lon, lat];
}

/**
 * Convert site rectangle corners to GeoJSON polygon coordinates.
 * Origin (0,0) = bottom-left corner in feet.
 * @param {number} originLat - latitude of bottom-left corner
 * @param {number} originLon - longitude of bottom-left corner
 * @param {number} widthFt - site width in feet (east)
 * @param {number} depthFt - site depth in feet (north)
 * @returns {Array} GeoJSON polygon coordinates [[lon,lat], ...]
 */
export function siteRectToGeoJSON(originLat, originLon, widthFt, depthFt) {
  return [
    feetToLatLon(originLat, originLon, 0, 0),
    feetToLatLon(originLat, originLon, widthFt, 0),
    feetToLatLon(originLat, originLon, widthFt, depthFt),
    feetToLatLon(originLat, originLon, 0, depthFt),
    feetToLatLon(originLat, originLon, 0, 0) // close the ring
  ];
}

/**
 * Convert a rectangle (in feet from site origin) to GeoJSON coordinates.
 */
export function rectToGeoJSON(originLat, originLon, x, y, width, height) {
  return [
    feetToLatLon(originLat, originLon, x, y),
    feetToLatLon(originLat, originLon, x + width, y),
    feetToLatLon(originLat, originLon, x + width, y + height),
    feetToLatLon(originLat, originLon, x, y + height),
    feetToLatLon(originLat, originLon, x, y) // close
  ];
}

/**
 * Convert a lot boundary (array of [x,y] in feet) to GeoJSON coordinates.
 */
export function boundaryToGeoJSON(originLat, originLon, boundary) {
  const coords = boundary.map(([x, y]) => feetToLatLon(originLat, originLon, x, y));
  coords.push(coords[0]); // close the ring
  return coords;
}

/**
 * Get center point of a boundary in feet.
 */
export function getBoundaryCenter(boundary) {
  const cx = boundary.reduce((s, [x]) => s + x, 0) / boundary.length;
  const cy = boundary.reduce((s, [, y]) => s + y, 0) / boundary.length;
  return [cx, cy];
}

/**
 * Compute the lat/lon of the center of a boundary.
 */
export function getBoundaryCenterLatLon(originLat, originLon, boundary) {
  const [cx, cy] = getBoundaryCenter(boundary);
  return feetToLatLon(originLat, originLon, cx, cy);
}
