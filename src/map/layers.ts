import L, { type LayerGroup, type Map as LeafletMap } from 'leaflet';
import {
  bearingLine,
  observationFromBearingEvent,
  type BearingConsensus,
  type FinalApproachEstimate,
} from '../location';
import type { AreaEstimate, Reception, SessionEvent, TargetProfile } from '../types';

export interface FinderLayers {
  confirmed: LayerGroup;
  forwarded: LayerGroup;
  ambiguous: LayerGroup;
  other: LayerGroup;
  estimate: LayerGroup;
  bearings: LayerGroup;
  bearingZone: LayerGroup;
  finalApproach: LayerGroup;
  reference: LayerGroup;
}

export function createFinderLayers(map: LeafletMap, showUntrustedAdminPosition = false): FinderLayers {
  const layers: FinderLayers = {
    confirmed: L.layerGroup().addTo(map),
    forwarded: L.layerGroup().addTo(map),
    ambiguous: L.layerGroup().addTo(map),
    other: L.layerGroup().addTo(map),
    estimate: L.layerGroup().addTo(map),
    bearings: L.layerGroup().addTo(map),
    bearingZone: L.layerGroup().addTo(map),
    finalApproach: L.layerGroup().addTo(map),
    reference: L.layerGroup(),
  };
  if (showUntrustedAdminPosition) layers.reference.addTo(map);
  L.control.layers({}, {
    'Confirmed direct': layers.confirmed,
    'Forwarded target-origin': layers.forwarded,
    'Ambiguous': layers.ambiguous,
    'Other receptions': layers.other,
    'Search area estimate': layers.estimate,
    'Bearing notes': layers.bearings,
    'Approximate bearing zone': layers.bearingZone,
    'Approximate final-approach zone': layers.finalApproach,
    'Admin-configured position — unverified': layers.reference,
  }, { collapsed: true }).addTo(map);
  return layers;
}

function targetLayer(reception: Reception, layers: FinderLayers): { layer: LayerGroup; color: string } {
  if (reception.cls.confirmed) return { layer: layers.confirmed, color: '#36dc88' };
  if (reception.cls.kind === 'TARGET_ORIGIN_BUT_FORWARDED' || reception.cls.kind === 'TARGET_IN_PATH_BUT_NOT_IMMEDIATE') {
    return { layer: layers.forwarded, color: '#a88cf2' };
  }
  if (reception.cls.kind === 'AMBIGUOUS_PREFIX') return { layer: layers.ambiguous, color: '#efb83f' };
  return { layer: layers.other, color: '#7f9188' };
}

export function drawReceptions(receptions: Reception[], layers: FinderLayers): void {
  for (const layer of [layers.confirmed, layers.forwarded, layers.ambiguous, layers.other]) layer.clearLayers();
  for (const reception of receptions) {
    if (reception.gps.lat == null || reception.gps.lon == null) continue;
    const style = targetLayer(reception, layers);
    L.circleMarker([reception.gps.lat, reception.gps.lon], {
      radius: reception.cls.confirmed ? 6 : 4,
      color: style.color,
      fillColor: style.color,
      fillOpacity: reception.cls.confirmed ? 0.75 : 0.35,
      weight: reception.cls.confirmed ? 2 : 1,
    })
      .bindTooltip(`${reception.cls.kind.replaceAll('_', ' ')} · ${reception.rssi} dBm`)
      .addTo(style.layer);
  }
}

export function drawEstimate(estimate: AreaEstimate | undefined, layers: FinderLayers): void {
  layers.estimate.clearLayers();
  if (!estimate?.ready || !estimate.polygon?.length) return;
  L.polygon(estimate.polygon.map(([lat, lon]) => [lat, lon] as [number, number]), {
    color: '#36dc88',
    fillColor: '#36dc88',
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '6 6',
  }).bindTooltip('Approximate strongest confirmed search area').addTo(layers.estimate);
}

export function drawBearings(events: SessionEvent[], layers: FinderLayers): void {
  layers.bearings.clearLayers();
  for (const event of events) {
    const observation = observationFromBearingEvent(event);
    if (!observation) continue;
    const line = bearingLine(observation, 150);
    L.polyline(line.map(({ lat, lon }) => [lat, lon] as [number, number]), { color: '#ffcf66', weight: 2 })
      .bindTooltip(`Observed bearing ${observation.bearingDeg}° ±${String(observation.accuracyDeg ?? '?')}°`)
      .addTo(layers.bearings);
  }
}

export function drawApproachZones(
  consensus: BearingConsensus | undefined,
  finalApproach: FinalApproachEstimate | undefined,
  layers: FinderLayers,
): void {
  layers.bearingZone.clearLayers();
  layers.finalApproach.clearLayers();
  if (consensus?.polygon.length) {
    L.polygon(consensus.polygon, {
      color: '#ffcf66',
      fillColor: '#ffcf66',
      fillOpacity: 0.12,
      weight: 2,
      dashArray: '4 6',
    }).bindTooltip(
      `Approximate bearing zone · ${consensus.confidence} confidence · ${Math.round(consensus.radiusM)} m uncertainty radius`,
    ).addTo(layers.bearingZone);
  }
  if (finalApproach?.ready && finalApproach.polygon?.length) {
    L.polygon(finalApproach.polygon, {
      color: '#40e0c2',
      fillColor: '#40e0c2',
      fillOpacity: 0.24,
      weight: 3,
    }).bindTooltip(
      `Approximate final-approach zone · ${finalApproach.confidence} confidence`,
    ).addTo(layers.finalApproach);
  }
}

export function drawTargetReference(target: TargetProfile | undefined, layers: FinderLayers): void {
  layers.reference.clearLayers();
  if (!target?.advertisedReference) return;
  const reference = target.advertisedReference;
  const tooltip = document.createElement('span');
  tooltip.textContent = `Admin-configured ${reference.source} position — unverified and display-only`;
  L.circleMarker([reference.lat, reference.lon], {
    radius: 8,
    color: '#62b6ff',
    fillColor: '#62b6ff',
    fillOpacity: 0.25,
    weight: 2,
    dashArray: '3 3',
  }).bindTooltip(tooltip).addTo(layers.reference);
}
