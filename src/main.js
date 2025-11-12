import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';

const appRoot = document.querySelector('#app');

const OSRM_BASE_URL = 'https://router.project-osrm.org';

appRoot.innerHTML = `
  <div class="app">
    <header>
      <h1>School Bus Route Optimizer</h1>
      <p>Select student pickup points, set the school location, and compute an optimized bus route using Ant Colony Optimization.</p>
    </header>
    <section class="controls">
      <div class="control-group">
        <button id="mode-student" class="active" title="Click map to add student pickup markers">Add Students</button>
        <button id="mode-school" title="Click map to set the school marker">Set School</button>
        <button id="clear-map" title="Remove all markers and routes">Clear Map</button>
      </div>
      <div class="control-group">
        <label>Ants
          <input type="number" id="ants-input" min="10" max="500" value="60" />
        </label>
        <label>Iterations
          <input type="number" id="iterations-input" min="10" max="400" value="120" />
        </label>
        <label>Alpha (pheromone)
          <input type="number" id="alpha-input" min="0.5" max="5" step="0.1" value="1.2" />
        </label>
        <label>Beta (visibility)
          <input type="number" id="beta-input" min="0.5" max="8" step="0.1" value="4" />
        </label>
        <label>Evaporation
          <input type="number" id="evaporation-input" min="0.1" max="0.9" step="0.05" value="0.45" />
        </label>
      </div>
      <div class="control-group">
        <button id="compute-route" disabled>Compute Route</button>
      </div>
    </section>
    <main>
      <div id="map"></div>
      <aside id="info-panel">
        <h2>Route Details</h2>
        <p id="status">Add at least one student pickup and a school location to enable optimization.</p>
        <p id="distance"></p>
        <ol id="route-list"></ol>
      </aside>
    </main>
  </div>
`;

const modeButtons = {
  student: document.getElementById('mode-student'),
  school: document.getElementById('mode-school')
};
const clearButton = document.getElementById('clear-map');
const computeButton = document.getElementById('compute-route');
const statusEl = document.getElementById('status');
const distanceEl = document.getElementById('distance');
const routeListEl = document.getElementById('route-list');
const antsInput = document.getElementById('ants-input');
const iterationsInput = document.getElementById('iterations-input');
const alphaInput = document.getElementById('alpha-input');
const betaInput = document.getElementById('beta-input');
const evaporationInput = document.getElementById('evaporation-input');

const map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

requestAnimationFrame(() => map.invalidateSize());
window.addEventListener('resize', () => map.invalidateSize());

let mode = 'student';
let students = [];
let studentMarkers = [];
let schoolLatLng = null;
let schoolMarker = null;
let routeLayer = null;

setMode('student');

modeButtons.student.addEventListener('click', () => setMode('student'));
modeButtons.school.addEventListener('click', () => setMode('school'));

map.on('click', (event) => {
  if (mode === 'student') {
    addStudentMarker(event.latlng);
  } else {
    setSchoolMarker(event.latlng);
  }
  updateComputeAvailability();
});

clearButton.addEventListener('click', () => {
  studentMarkers.forEach((marker) => map.removeLayer(marker));
  studentMarkers = [];
  students = [];
  if (schoolMarker) {
    map.removeLayer(schoolMarker);
    schoolMarker = null;
  }
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  schoolLatLng = null;
  routeListEl.innerHTML = '';
  distanceEl.textContent = '';
  statusEl.textContent = 'Map cleared. Add student pickups, then set the school.';
  updateComputeAvailability();
});

computeButton.addEventListener('click', async () => {
  if (!schoolLatLng || !students.length) {
    return;
  }

  computeButton.disabled = true;

  try {
    const rawAnts = parseInt(antsInput.value, 10);
    const rawIterations = parseInt(iterationsInput.value, 10);
    const ants = Number.isFinite(rawAnts) ? Math.max(rawAnts, students.length + 1) : Math.max(60, students.length + 1);
    const iterations = Number.isFinite(rawIterations) ? rawIterations : 120;
    const alpha = parseFloat(alphaInput.value) || 1.2;
    const beta = parseFloat(betaInput.value) || 4;
    const evaporation = parseFloat(evaporationInput.value) || 0.45;

    statusEl.textContent = 'Fetching road-network distances from OSRM...';
    await waitFrame();

    const nodes = buildNodeList();
    const distanceMatrix = await getDistanceMatrix(nodes);

    statusEl.textContent = 'Running ant colony optimization...';
    await waitFrame();

    const t0 = performance.now();
    const result = antColonyOptimization(distanceMatrix, {
      ants,
      iterations,
      alpha,
      beta,
      evaporation,
      q: 120
    });
    const elapsed = performance.now() - t0;

    if (!result || !Array.isArray(result.tour)) {
      throw new Error('Optimization failed. Try adjusting parameters or adding more ants/iterations.');
    }

    let osrmRoute = null;
    try {
      statusEl.textContent = 'Fetching street-aligned route...';
      osrmRoute = await fetchOsrmRoute(result.tour, nodes);
    } catch (routeError) {
      console.warn('OSRM route fetch failed, drawing straight segments instead.', routeError);
    }

    renderRoute(result.tour, nodes, osrmRoute?.latLngs);
    const km = (osrmRoute?.distanceKm ?? result.length);
    const duration = osrmRoute?.durationMinutes;
    const distanceSummary = duration
      ? `Total path length: ${km.toFixed(2)} km (~${duration.toFixed(1)} min)`
      : `Total path length: ${km.toFixed(2)} km`;
    distanceEl.textContent = distanceSummary;
    const baseMessage = `Route updated in ${(elapsed / 1000).toFixed(2)} s using ${ants} ants and ${iterations} iterations.`;
    statusEl.textContent = osrmRoute
      ? `${baseMessage} Road-following polyline retrieved from OSRM.`
      : `${baseMessage} Shown as straight segments (OSRM unavailable).`;
  } catch (error) {
    console.error(error);
    statusEl.textContent = typeof error?.message === 'string'
      ? `Optimization failed: ${error.message}`
      : 'Optimization failed due to an unexpected error.';
  } finally {
    computeButton.disabled = false;
  }
});

function setMode(nextMode) {
  mode = nextMode;
  Object.entries(modeButtons).forEach(([key, button]) => {
    button.classList.toggle('active', key === mode);
  });
  statusEl.textContent = mode === 'student'
    ? 'Click on the map to add student pickup markers. Right-click a marker to remove it.'
    : 'Click on the map to set the school location. Only one school marker is allowed.';
}

function addStudentMarker(latlng) {
  const marker = L.circleMarker(latlng, {
    radius: 8,
    color: '#0f8ec7',
    weight: 2,
    fillColor: '#0f8ec7',
    fillOpacity: 0.85
  }).addTo(map);
  marker.bindPopup(`Student ${students.length + 1}`);
  marker.on('contextmenu', () => removeStudentMarker(marker));
  students.push(latlng);
  studentMarkers.push(marker);
  statusEl.textContent = `${students.length} student pickup${students.length === 1 ? '' : 's'} placed.`;
}

function removeStudentMarker(marker) {
  const idx = studentMarkers.indexOf(marker);
  if (idx === -1) {
    return;
  }
  map.removeLayer(marker);
  studentMarkers.splice(idx, 1);
  students.splice(idx, 1);
  statusEl.textContent = students.length
    ? `${students.length} student pickup${students.length === 1 ? '' : 's'} remaining.`
    : 'All student markers removed.';
  updateComputeAvailability();
}

function setSchoolMarker(latlng) {
  if (schoolMarker) {
    map.removeLayer(schoolMarker);
  }
  schoolLatLng = latlng;
  schoolMarker = L.circleMarker(latlng, {
    radius: 10,
    color: '#ef476f',
    weight: 3,
    fillColor: '#ef476f',
    fillOpacity: 0.9
  }).addTo(map);
  schoolMarker.bindPopup('School');
  statusEl.textContent = 'School location set. Add students or compute the route when ready.';
}

function updateComputeAvailability() {
  computeButton.disabled = !(schoolLatLng && students.length > 0);
}

function buildNodeList() {
  const nodeList = [{
    label: 'School',
    lat: schoolLatLng.lat,
    lng: schoolLatLng.lng
  }];
  students.forEach((latlng, idx) => {
    nodeList.push({
      label: `Student ${idx + 1}`,
      lat: latlng.lat,
      lng: latlng.lng
    });
  });
  return nodeList;
}

async function getDistanceMatrix(nodes) {
  const maxPublicOsrmNodes = 100;
  if (nodes.length > maxPublicOsrmNodes) {
    statusEl.textContent = `Public OSRM limit exceeded (${nodes.length} > ${maxPublicOsrmNodes}). Falling back to straight-line distances.`;
    await waitFrame();
    return buildHaversineMatrix(nodes);
  }

  try {
    const matrix = await fetchOsrmMatrix(nodes);
    return matrix;
  } catch (error) {
    console.warn('OSRM matrix unavailable, using straight-line distances instead.', error);
    statusEl.textContent = 'OSRM matrix unavailable. Using straight-line distances as fallback.';
    await waitFrame();
    return buildHaversineMatrix(nodes);
  }
}

function buildHaversineMatrix(nodes) {
  const matrix = Array.from({ length: nodes.length }, () => Array(nodes.length).fill(0));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const distance = haversineDistance(nodes[i], nodes[j]);
      matrix[i][j] = distance;
      matrix[j][i] = distance;
    }
  }
  return matrix;
}

async function fetchOsrmMatrix(nodes) {
  const coords = nodes.map((node) => `${node.lng},${node.lat}`).join(';');
  const url = `${OSRM_BASE_URL}/table/v1/driving/${coords}?annotations=distance`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM table request failed with status ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data.distances)) {
    throw new Error('OSRM response missing distance matrix');
  }
  const fallbackDistance = 1e6; // km ~ far away to discourage unreachable hops
  return data.distances.map((row) => row.map((value) => (Number.isFinite(value) ? value / 1000 : fallbackDistance)));
}

async function fetchOsrmRoute(tour, nodes) {
  if (!tour || tour.length < 2) {
    throw new Error('Route requires at least two points.');
  }
  const coords = tour.map((index) => `${nodes[index].lng},${nodes[index].lat}`).join(';');
  const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM route request failed with status ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data.routes) || !data.routes.length) {
    throw new Error('OSRM response missing route geometry');
  }
  const route = data.routes[0];
  if (!route || !route.geometry || !Array.isArray(route.geometry.coordinates)) {
    throw new Error('OSRM route geometry invalid.');
  }
  return {
    latLngs: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distanceKm: Number.isFinite(route.distance) ? route.distance / 1000 : undefined,
    durationMinutes: Number.isFinite(route.duration) ? route.duration / 60 : undefined
  };
}

function haversineDistance(a, b) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function antColonyOptimization(distanceMatrix, config) {
  const { ants, iterations, alpha, beta, evaporation, q } = config;
  const size = distanceMatrix.length;
  if (size < 2) {
    return null;
  }

  const pheromone = Array.from({ length: size }, () => Array(size).fill(1));
  let bestTour = null;
  let bestLength = Infinity;

  for (let iter = 0; iter < iterations; iter++) {
    const iterationTours = [];
    const iterationLengths = [];

    for (let ant = 0; ant < ants; ant++) {
      const tour = buildTour(pheromone, distanceMatrix, alpha, beta);
      const length = tourLength(tour, distanceMatrix);
      iterationTours.push(tour);
      iterationLengths.push(length);
      if (length < bestLength) {
        bestLength = length;
        bestTour = tour;
      }
    }

    evaporatePheromone(pheromone, evaporation);
    depositPheromones(pheromone, iterationTours, iterationLengths, q);
  }

  return bestTour ? { tour: bestTour, length: bestLength } : null;
}

function buildTour(pheromone, distanceMatrix, alpha, beta) {
  const size = distanceMatrix.length;
  const unvisited = new Set();
  for (let i = 1; i < size; i++) {
    unvisited.add(i);
  }

  const tour = [0];
  let current = 0;

  while (unvisited.size > 0) {
    const next = chooseNext(current, unvisited, pheromone, distanceMatrix, alpha, beta);
    tour.push(next);
    unvisited.delete(next);
    current = next;
  }

  tour.push(0);
  return tour;
}

function chooseNext(current, unvisited, pheromone, distanceMatrix, alpha, beta) {
  let sum = 0;
  const weights = [];
  unvisited.forEach((candidate) => {
    const tau = pheromone[current][candidate] ** alpha;
    const distance = distanceMatrix[current][candidate];
    const eta = (distance === 0 ? Number.MAX_SAFE_INTEGER : (1 / distance)) ** beta;
    const weight = tau * eta;
    sum += weight;
    weights.push({ candidate, weight });
  });

  if (sum === 0) {
    return [...unvisited][Math.floor(Math.random() * unvisited.size)];
  }

  let threshold = Math.random() * sum;
  for (const entry of weights) {
    threshold -= entry.weight;
    if (threshold <= 0) {
      return entry.candidate;
    }
  }
  return weights[weights.length - 1].candidate;
}

function tourLength(tour, distanceMatrix) {
  let total = 0;
  for (let i = 0; i < tour.length - 1; i++) {
    total += distanceMatrix[tour[i]][tour[i + 1]];
  }
  return total;
}

function evaporatePheromone(pheromone, evaporation) {
  for (let i = 0; i < pheromone.length; i++) {
    for (let j = 0; j < pheromone.length; j++) {
      pheromone[i][j] = Math.max(1e-6, (1 - evaporation) * pheromone[i][j]);
    }
  }
}

function depositPheromones(pheromone, tours, lengths, q) {
  for (let idx = 0; idx < tours.length; idx++) {
    const tour = tours[idx];
    const length = lengths[idx];
    const deposit = q / length;
    for (let i = 0; i < tour.length - 1; i++) {
      const from = tour[i];
      const to = tour[i + 1];
      pheromone[from][to] += deposit;
      pheromone[to][from] += deposit;
    }
  }
}

function renderRoute(tour, nodes, geometryLatLngs) {
  if (routeLayer) {
    map.removeLayer(routeLayer);
  }
  const latLngs = Array.isArray(geometryLatLngs) && geometryLatLngs.length > 1
    ? geometryLatLngs
    : tour.map((index) => [nodes[index].lat, nodes[index].lng]);
  routeLayer = L.polyline(latLngs, {
    color: '#ffa600',
    weight: 4,
    opacity: 0.85
  }).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });

  routeListEl.innerHTML = '';
  tour.forEach((index, idx) => {
    const item = document.createElement('li');
    const node = nodes[index];
    const prefix = idx === 0 ? 'Start' : idx === tour.length - 1 ? 'Return' : `Stop ${idx}`;
    item.textContent = `${prefix}: ${node.label}`;
    routeListEl.appendChild(item);
  });
}

function waitFrame() {
  return new Promise((resolve) => setTimeout(resolve, 16));
}
