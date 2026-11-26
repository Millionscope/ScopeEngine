/**
 * Solar system data and Kepler math (ported from Atlas26 app/astronomy/planetOrbit.ts, no three.js).
 *  - orbital periods follow Kepler's third law from the real semi-major axes (AU);
 *  - mean longitude and longitude of perihelion at J2000 place each planet at its real heliocentric
 *    longitude for a date (Atlas26 started every planet at perihelion on J2000);
 *  - rotation periods are the real sidereal days (Atlas26 used 24 h for Mercury and Venus); a
 *    negative period is retrograde spin (Venus). Uranus spins retrograde through its 97.77° tilt.
 * Scene layout: Atlas26's orbit radii (3, 5, 8 … 36) × 1.5; planet radii are sqrt-compressed from
 * the real ones so the size order and ratios read correctly while Mercury stays visible.
 * Orbits are prograde: counter-clockwise seen from +Y (north), the same sense as +rotation.y spin.
 * @module editors/solar/orbits
 */

export const EARTH_YEAR_DAYS = 365.2422;
const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

/** T = T_earth · a^1.5 (a in AU). */
export const keplerPeriodDays = (aAU) => EARTH_YEAR_DAYS * aAU ** 1.5;

/** Earth radius in scene units; other bodies scale by sqrt(r / r_earth). */
const EARTH_R = 0.32;
const sceneRadius = (km) => EARTH_R * Math.sqrt(km / 6371);

export const SUN = { id: 'sun', name: 'Sun', radius: 1.6, radiusKm: 696340, rotationHours: 609.12, tiltDeg: 7.25, tex: '/textures/sun.jpg', color: '#ffc845', text: 'G-type main-sequence star holding 99.86% of the system’s mass. Its equator turns once every 25.4 days.' };

/**
 * a: AU, e: eccentricity, L: mean longitude at J2000 (deg), w: longitude of perihelion (deg),
 * sceneA: semi-major axis in scene units, rotationHours: sidereal day (negative = retrograde).
 */
const RAW = [
  { id: 'mercury', name: 'Mercury', a: 0.387098, e: 0.2056, L: 252.25, w: 77.46, sceneA: 4.5, radiusKm: 2439.7, rotationHours: 1407.6, tiltDeg: 0.034, tex: '/textures/solar/mercury.jpg', color: '#b4aca4', atmo: null, text: 'Smallest planet and closest to the Sun. Its slow spin gives it 3 days for every 2 years.' },
  { id: 'venus', name: 'Venus', a: 0.723332, e: 0.0068, L: 181.98, w: 131.53, sceneA: 7.5, radiusKm: 6051.8, rotationHours: -5832.5, tiltDeg: 2.64, tex: '/textures/solar/venus_atmosphere.jpg', color: '#e8c48a', atmo: '#ffd9a0', text: 'Turns backwards, and so slowly that its day is longer than its year, under a crushing CO₂ atmosphere.' },
  { id: 'earth', name: 'Earth', a: 1.000001, e: 0.0167, L: 100.46, w: 102.94, sceneA: 12, radiusKm: 6371, rotationHours: 23.934, tiltDeg: 23.44, tex: '/textures/earth_daymap_4k.jpg', night: '/textures/earth_nightmap.jpg', clouds: '/textures/earth_clouds.jpg', color: '#3fa9ff', atmo: '#4da6ff', text: 'Our home world: liquid oceans, a protective magnetic field and a nitrogen–oxygen atmosphere.' },
  { id: 'mars', name: 'Mars', a: 1.523662, e: 0.0934, L: 355.45, w: 336.04, sceneA: 18, radiusKm: 3389.5, rotationHours: 24.623, tiltDeg: 25.19, tex: '/textures/solar/mars.jpg', color: '#ff7a4d', atmo: '#ff9a6a', text: 'Cold desert world with the tallest volcano in the system, Olympus Mons, and a day close to Earth’s.' },
  { id: 'jupiter', name: 'Jupiter', a: 5.203363, e: 0.0484, L: 34.40, w: 14.75, sceneA: 27, radiusKm: 69911, rotationHours: 9.925, tiltDeg: 3.13, tex: '/textures/solar/jupiter.jpg', color: '#e0b48a', atmo: '#ffd2a8', text: 'Gas giant with the fastest spin in the system: a day of under ten hours flattens its poles.' },
  { id: 'saturn', name: 'Saturn', a: 9.53707, e: 0.0542, L: 49.94, w: 92.43, sceneA: 36, radiusKm: 58232, rotationHours: 10.656, tiltDeg: 26.73, tex: '/textures/solar/saturn.jpg', ring: '/textures/solar/saturn_ring.png', color: '#f0d9a0', atmo: '#ffe6b0', text: 'Ringed gas giant less dense than water. The rings are ice and rock, mostly under a kilometre thick.' },
  { id: 'uranus', name: 'Uranus', a: 19.191264, e: 0.0472, L: 313.23, w: 170.96, sceneA: 45, radiusKm: 25362, rotationHours: 17.24, tiltDeg: 97.77, tex: '/textures/uranus.jpg', color: '#7fe3f0', atmo: '#9ff4ff', text: 'Ice giant knocked onto its side: its 97.8° tilt makes it roll along its orbit and spin retrograde.' },
  { id: 'neptune', name: 'Neptune', a: 30.068963, e: 0.0086, L: 304.88, w: 44.97, sceneA: 54, radiusKm: 24622, rotationHours: 16.11, tiltDeg: 28.32, tex: '/textures/neptune.jpg', color: '#4d7dff', atmo: '#6f9bff', text: 'Outermost planet, with the fastest winds measured in the system, over 2,000 km/h.' },
];

export const PLANETS = RAW.map((p) => ({ ...p, periodDays: keplerPeriodDays(p.a), radius: sceneRadius(p.radiusKm) }));

/** @param {number} ms epoch milliseconds */
export const daysSinceJ2000 = (ms) => (ms - J2000_MS) / 86400000;

/** Solve E − e·sin E = M (Newton). */
function solveKepler(M, e) {
  let E = M;
  for (let i = 0; i < 10; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/** Scene radius at true anomaly nu. */
const radiusAt = (p, nu) => (p.sceneA * (1 - p.e * p.e)) / (1 + p.e * Math.cos(nu));

/**
 * Heliocentric position in the XZ plane (scene units) for days since J2000.
 * @returns {{x: number, z: number, r: number, au: number}}
 */
export function orbitPosition(p, days) {
  const M = ((p.L - p.w) * DEG + (days / p.periodDays) * Math.PI * 2) % (Math.PI * 2);
  const E = solveKepler(M, p.e);
  const nu = 2 * Math.atan2(Math.sqrt(1 + p.e) * Math.sin(E / 2), Math.sqrt(1 - p.e) * Math.cos(E / 2));
  const r = radiusAt(p, nu);
  const th = nu + p.w * DEG;
  return { x: r * Math.cos(th), z: -r * Math.sin(th), r, au: (r / p.sceneA) * p.a };
}

/** Closed orbit ellipse as n XYZ points (y = 0). */
export function orbitPath(p, n = 256) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const nu = (i / n) * Math.PI * 2;
    const r = radiusAt(p, nu);
    const th = nu + p.w * DEG;
    out[i * 3] = r * Math.cos(th);
    out[i * 3 + 2] = -r * Math.sin(th);
  }
  return out;
}

/** Spin angle (rad) after `hours` of simulated time. */
export const spinAngle = (rotationHours, hours) => ((hours / rotationHours) % 1) * Math.PI * 2;
