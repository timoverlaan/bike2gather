import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Evaluation, LatLon, Leg, Person, Place } from '../types';
import { t } from '../i18n';
import { esc } from './dom';

export const PERSON_COLORS = ['#e4572e', '#2f7fd8', '#9b4fd1', '#d99a00', '#159a8c', '#d6457f', '#5f8a1f', '#8d6e63'];
export const personColor = (i: number) => PERSON_COLORS[i % PERSON_COLORS.length];
const SHARED_COLOR = '#1f6f43';

const NL_BOUNDS = L.latLngBounds([50.7, 3.2], [53.6, 7.3]);

export class MapView {
  map: L.Map;
  private base = L.layerGroup();
  private candidates = L.layerGroup();
  private routes = L.layerGroup();
  private options = L.layerGroup();
  private pickHandler: ((p: LatLon) => void) | null = null;

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: true, maxBounds: NL_BOUNDS.pad(0.3), minZoom: 7 }).setView([52.15, 5.3], 8);
    // PDOK BRT-Achtergrondkaart (Kadaster), CC BY 4.0, no key needed.
    L.tileLayer('https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/pastel/EPSG:3857/{z}/{x}/{y}.png', {
      minZoom: 6,
      maxZoom: 19,
      attribution:
        'Kaart &copy; <a href="https://www.kadaster.nl">Kadaster</a> (PDOK) · Data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Routes <a href="https://routing.openstreetmap.de/about.html">FOSSGIS OSRM</a>',
    }).addTo(this.map);
    this.candidates.addTo(this.map);
    this.routes.addTo(this.map);
    this.base.addTo(this.map);
    this.options.addTo(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (!this.pickHandler) return;
      const h = this.pickHandler;
      this.setPick(null);
      h({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }

  setPick(handler: ((p: LatLon) => void) | null) {
    this.pickHandler = handler;
    this.map.getContainer().classList.toggle('picking', !!handler);
  }

  invalidate() {
    this.map.invalidateSize();
  }

  /** Homes and destination. */
  drawBase(people: Person[], dest: Place | null, onDrag: (target: string, p: LatLon) => void) {
    this.base.clearLayers();
    people.forEach((p, i) => {
      if (!p.home) return;
      const label = (p.name || t('riderN', { n: i + 1 })).trim();
      const m = L.marker([p.home.lat, p.home.lon], {
        icon: L.divIcon({
          className: 'pin-wrap',
          html: `<div class="pin home" style="--c:${personColor(i)}">${esc(label.charAt(0).toUpperCase())}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        draggable: true,
        title: t('homeOf', { name: label }),
      }).bindTooltip(esc(t('homeOf', { name: label })));
      m.on('dragend', () => {
        const ll = m.getLatLng();
        onDrag(p.id, { lat: ll.lat, lon: ll.lng });
      });
      this.base.addLayer(m);
    });
    if (dest) {
      const m = L.marker([dest.lat, dest.lon], {
        icon: L.divIcon({
          className: 'pin-wrap',
          html: `<div class="pin dest">${destSvg}</div>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
        draggable: true,
        zIndexOffset: 2000,
      }).bindTooltip(esc(dest.label));
      m.on('dragend', () => {
        const ll = m.getLatLng();
        onDrag('dest', { lat: ll.lat, lon: ll.lng });
      });
      this.base.addLayer(m);
    }
  }

  fitTo(points: LatLon[]) {
    if (!points.length) return;
    if (points.length === 1) {
      this.map.setView([points[0].lat, points[0].lon], 14);
      return;
    }
    this.map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number])), { padding: [40, 40] });
  }

  /** Every scored candidate as a faint dot, coloured from good (green) to poor (grey). */
  drawCandidates(all: Evaluation[]) {
    this.candidates.clearLayers();
    if (!all.length) return;
    const totals = all.map((e) => e.score.total).sort((a, b) => a - b);
    const lo = totals[0];
    const hi = totals[Math.floor(totals.length * 0.8)] ?? totals[totals.length - 1];
    for (const e of all) {
      if (e.candidate.custom) continue;
      const q = hi > lo ? Math.min(1, Math.max(0, (e.score.total - lo) / (hi - lo))) : 0;
      L.circleMarker([e.candidate.lat, e.candidate.lon], {
        radius: 4,
        weight: 1,
        color: '#fff',
        fillColor: `hsl(${140 - q * 110}, ${60 - q * 40}%, ${38 + q * 22}%)`,
        fillOpacity: 0.85,
        interactive: false,
      }).addTo(this.candidates);
    }
  }

  drawOptions(options: Evaluation[], selected: string | null, onSelect: (id: string) => void) {
    this.options.clearLayers();
    options.forEach((o, i) => {
      const c = o.candidate;
      const isSel = c.id === selected;
      const m = L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          className: 'pin-wrap',
          html: `<div class="pin option${isSel ? ' selected' : ''}${c.custom ? ' custom' : ''}">${c.custom ? '★' : i + 1}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        zIndexOffset: isSel ? 1000 : 400,
      });
      if (c.name) m.bindTooltip(esc(c.name));
      m.on('click', () => onSelect(c.id));
      this.options.addLayer(m);
    });
  }

  drawRoutes(legs: { person: Leg[]; shared: Leg } | undefined) {
    this.routes.clearLayers();
    if (!legs) return;
    const outline = { color: '#fff', weight: 9, opacity: 0.9 };
    legs.person.forEach((l, i) => {
      L.polyline(l.coords, outline).addTo(this.routes);
      L.polyline(l.coords, { color: personColor(i), weight: 5, opacity: 0.9 }).addTo(this.routes);
    });
    L.polyline(legs.shared.coords, { ...outline, weight: 12 }).addTo(this.routes);
    L.polyline(legs.shared.coords, { color: SHARED_COLOR, weight: 7, opacity: 0.95 }).addTo(this.routes);
  }

  clearResults() {
    this.candidates.clearLayers();
    this.routes.clearLayers();
    this.options.clearLayers();
  }
}

const destSvg =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M10 3h4a2 2 0 0 1 2 2v2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2zm0 2v2h4V5h-4z"/></svg>';
