import L, { type Map as LeafletMap } from 'leaflet';
import type { AreaEstimate, Reception, SessionEvent, TargetProfile } from '../types';
import { createFinderLayers, drawBearings, drawEstimate, drawReceptions, drawTargetReference, type FinderLayers } from './layers';

export class FinderMap {
  #map?: LeafletMap;
  #layers?: FinderLayers;

  get mounted(): boolean {
    return this.#map !== undefined;
  }

  mount(element: HTMLElement, receptions: Reception[], estimate?: AreaEstimate, events: SessionEvent[] = [], target?: TargetProfile): void {
    this.destroy();
    this.#map = L.map(element, { zoomControl: true, preferCanvas: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.#map);
    this.#layers = createFinderLayers(this.#map);
    this.update(receptions, estimate, events, target);
    const located = receptions.filter((item) => item.gps.lat != null && item.gps.lon != null);
    const points = located.map((item) => [item.gps.lat!, item.gps.lon!] as [number, number]);
    if (points.length === 0 && target?.lastKnown) points.push([target.lastKnown.lat, target.lastKnown.lon]);
    if (points.length) {
      const bounds = L.latLngBounds(points);
      this.#map.fitBounds(bounds.pad(0.2), { maxZoom: 17 });
    } else {
      this.#map.setView([0, 0], 2);
    }
    setTimeout(() => this.#map?.invalidateSize(), 0);
  }

  update(receptions: Reception[], estimate?: AreaEstimate, events: SessionEvent[] = [], target?: TargetProfile): void {
    if (!this.#layers) return;
    drawReceptions(receptions, this.#layers);
    drawEstimate(estimate, this.#layers);
    drawBearings(events, this.#layers);
    drawTargetReference(target, this.#layers);
  }

  invalidateSize(): void {
    this.#map?.invalidateSize({ pan: false });
  }

  destroy(): void {
    this.#map?.remove();
    this.#map = undefined;
    this.#layers = undefined;
  }
}
