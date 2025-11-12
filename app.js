const map = L.map('map', { zoomControl: true }).setView([39.0, 35.0], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

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

let mode = 'student';
let students = [];
let studentMarkers = [];
let schoolLatLng = null;
let schoolMarker = null;
let routeLayer = null;

function setMode(nextMode) {
  mode = nextMode;
  Object.entries(modeButtons).forEach(([key, button]) => {
    button.classList.toggle('active', key === mode);
  });
  statusEl.textContent = mode === 'student'
    ? 'Click on the map to add student pickup markers. Right-click a marker to remove it.'
    : 'Click on the map to set the school location. Only one school marker is allowed.';
}

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

function updateComputeAvailability() {
  computeButton.disabled = !(schoolLatLng && students.length > 0);
}

computeButton.addEventListener('click', async () => {
  if (!schoolLatLng || !students.length) {
    return;
  }
  const rawAnts = parseInt(antsInput.value, 10);
  const rawIterations = parseInt(iterationsInput.value, 10);
  const ants = Number.isFinite(rawAnts) ? Math.max(rawAnts, students.length + 1) : Math.max(60, students.length + 1);
  const iterations = Number.isFinite(rawIterations) ? rawIterations : 120;
  const alpha = parseFloat(alphaInput.value) || 1.2;
  const beta = parseFloat(betaInput.value) || 4;
  const evaporation = parseFloat(evaporationInput.value) || 0.45;

  statusEl.textContent = 'Running ant colony optimization...';
  await waitFrame();

  const nodes = buildNodeList();
  const distanceMatrix = buildDistanceMatrix(nodes);
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
    statusEl.textContent = 'Optimization failed. Try adjusting parameters or adding more ants/iterations.';
    return;
  }

  renderRoute(result.tour, nodes);
  const km = result.length;
  distanceEl.textContent = `Total path length: ${km.toFixed(2)} km`;
  statusEl.textContent = `Route updated in ${(elapsed / 1000).toFixed(2)} s using ${ants} ants and ${iterations} iterations.`;
});

function waitFrame() {
  return new Promise((resolve) => setTimeout(resolve, 30));
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

function buildDistanceMatrix(nodes) {
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

function renderRoute(tour, nodes) {
  if (routeLayer) {
    map.removeLayer(routeLayer);
  }
  const latLngs = tour.map((index) => [nodes[index].lat, nodes[index].lng]);
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
