// Stand-alone crowd map for the mobile app (shown in a WebView / iframe).
// Data comes in the URL hash as JSON:
//   { lat, lon, theme: "light"|"dark", points: [[lat, lon, weight]], closed: [[lat, lon, name]] }
// Changing the hash redraws the map.
import * as L from 'leaflet';
import { HeatLayer } from 'leaflet.heat';
import 'leaflet/dist/leaflet.css';

function read() {
  try { return JSON.parse(decodeURIComponent(location.hash.slice(1)) || '{}'); } catch (e) { return {}; }
}

let data = read();
document.body.className = data.theme === 'dark' ? 'dark' : '';
const map = L.map('map', { zoomControl: true, attributionControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const heat = new HeatLayer([], { radius: 30, blur: 24, max: 1.6, maxZoom: 12, minOpacity: 0.25, gradient: { 0.3: '#3b82f6', 0.55: '#22c55e', 0.75: '#facc15', 1: '#ef4444' } }).addTo(map);
const closed = L.layerGroup().addTo(map);

function draw(fit) {
  heat.setLatLngs(data.points || []);
  closed.clearLayers();
  (data.closed || []).forEach(function (c) {
    L.circleMarker([c[0], c[1]], { radius: 7, color: '#9ca3af', weight: 2, dashArray: '3 3', fillColor: '#4b5563', fillOpacity: 0.85 })
      .bindTooltip(String(c[2] || '') + ' · closed', { direction: 'top' })
      .addTo(closed);
  });
  if (!fit) return;
  const all = (data.points || []).map(function (p) { return [p[0], p[1]]; }).concat((data.closed || []).map(function (c) { return [c[0], c[1]]; }));
  if (all.length) {
    // Frame the main cluster; a far-off place shouldn't zoom the map out.
    const mid = [all.map((p) => p[0]).sort()[all.length >> 1], all.map((p) => p[1]).sort()[all.length >> 1]];
    const dist = (p) => Math.hypot(p[0] - mid[0], (p[1] - mid[1]) * Math.cos(mid[0] * Math.PI / 180));
    const ds = all.map(dist).sort((a, b) => a - b);
    const limit = Math.max(ds[Math.floor(ds.length * 0.8)] * 1.5, 0.01);
    const core = all.filter((p) => dist(p) <= limit);
    map.fitBounds(L.latLngBounds(core.length ? core : all).pad(0.1), { maxZoom: 14 });
  } else if (typeof data.lat === 'number') {
    map.setView([data.lat, data.lon], 12);
  } else {
    map.setView([20, 0], 2);
  }
}
draw(true);
window.addEventListener('hashchange', function () {
  const next = read();
  const moved = next.lat !== data.lat || next.lon !== data.lon;
  data = next;
  document.body.className = data.theme === 'dark' ? 'dark' : '';
  draw(moved);
});
