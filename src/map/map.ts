import L, { type Map as LeafletMap } from 'leaflet';
import type {
  BearingConsensus,
  FinalApproachEstimate,
  RemoteObserverAnalysis,
  RemoteObserverCombinedZone,
} from '../location';
import type { AreaEstimate, Reception, RemoteObserverEvidence, SessionEvent, TargetProfile } from '../types';
import {
  createFinderLayers,
  drawApproachZones,
  drawBearings,
  drawEstimate,
  drawReceptions,
  drawRemoteObserverAssist,
  drawTargetReference,
  type FinderLayers,
} from './layers';

/**
 * Only measured reception positions may frame the operational map. The target
 * argument makes the trust boundary explicit: its admin-configured reference
 * is deliberately ignored even when the display layer is enabled.
 */
export function finderViewportPoints(
  receptions: readonly Reception[],
  _target?: TargetProfile,
): Array<[number, number]> {
  return receptions
    .filter((item) => item.gps.lat != null && item.gps.lon != null)
    .map((item) => [item.gps.lat!, item.gps.lon!] as [number, number]);
}

export class FinderMap {
  #map?: LeafletMap;
  #layers?: FinderLayers;

  get mounted(): boolean {
    return this.#map !== undefined;
  }

  mount(
    element: HTMLElement,
    receptions: Reception[],
    estimate?: AreaEstimate,
    events: SessionEvent[] = [],
    target?: TargetProfile,
    showUntrustedAdminPosition = false,
    bearingConsensus?: BearingConsensus,
    finalApproach?: FinalApproachEstimate,
    observerEvidence: RemoteObserverEvidence[] = [],
    remoteObserverAnalysis?: RemoteObserverAnalysis,
    communityAssistedZone?: RemoteObserverCombinedZone,
  ): void {
    this.destroy();
    this.#map = L.map(element, { zoomControl: true, preferCanvas: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.#map);
    this.#layers = createFinderLayers(this.#map, showUntrustedAdminPosition);
    this.update(
      receptions,
      estimate,
      events,
      target,
      bearingConsensus,
      finalApproach,
      observerEvidence,
      remoteObserverAnalysis,
      communityAssistedZone,
    );
    const points = finderViewportPoints(receptions, target);
    if (points.length) {
      const bounds = L.latLngBounds(points);
      this.#map.fitBounds(bounds.pad(0.2), { maxZoom: 17 });
    } else {
      this.#map.setView([0, 0], 2);
    }
    setTimeout(() => this.#map?.invalidateSize(), 0);
  }

  update(
    receptions: Reception[],
    estimate?: AreaEstimate,
    events: SessionEvent[] = [],
    target?: TargetProfile,
    bearingConsensus?: BearingConsensus,
    finalApproach?: FinalApproachEstimate,
    observerEvidence: RemoteObserverEvidence[] = [],
    remoteObserverAnalysis?: RemoteObserverAnalysis,
    communityAssistedZone?: RemoteObserverCombinedZone,
  ): void {
    if (!this.#layers) return;
    drawReceptions(receptions, this.#layers);
    drawEstimate(estimate, this.#layers);
    drawBearings(events, this.#layers);
    drawApproachZones(bearingConsensus, finalApproach, this.#layers);
    drawRemoteObserverAssist(observerEvidence, remoteObserverAnalysis, communityAssistedZone, this.#layers);
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
