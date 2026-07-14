import L, { type LayerGroup, type Map as LeafletMap } from 'leaflet';
import type { AreaEstimate, Reception, SessionEvent, TargetProfile } from '../types';

export interface FinderLayers {
  confirmed: LayerGroup;
  forwarded: LayerGroup;
  ambiguous: LayerGroup;
  other: LayerGroup;
  estimate: LayerGroup;
  bearings: LayerGroup;
  reference: LayerGroup;
}

export function createFinderLayers(map: LeafletMap): FinderLayers {
  const layers: FinderLayers = {
    confirmed: L.layerGroup().addTo(map),
    forwarded: L.layerGroup().addTo(map),
    ambiguous: L.layerGroup().addTo(map),
    other: L.layerGroup().addTo(map),
    estimate: L.layerGroup().addTo(map),
    bearings: L.layerGroup().addTo(map),
    reference: L.layerGroup().addTo(map),
  };
  L.control.layers({}, {
    'Confirmed direct': layers.confirmed,
    'Forwarded target-origin': layers.forwarded,
    'Ambiguous': layers.ambiguous,
    'Other receptions': layers.other,
    'Search area estimate': layers.estimate,
    'Bearing notes': layers.bearings,
    'Last self-reported target position': layers.reference,
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
  }).bindTooltip('Strongest confirmed search area — not an exact position').addTo(layers.estimate);
}

export function drawBearings(events: SessionEvent[], layers: FinderLayers): void {
  layers.bearings.clearLayers();
  for (const event of events) {
    if (event.type !== 'bearing') continue;
    const { lat, lon, degrees, uncertainty } = event.data;
    if (![lat, lon, degrees].every((value) => typeof value === 'number')) continue;
    const start: [number, number] = [lat as number, lon as number];
    const radians = ((degrees as number) * Math.PI) / 180;
    const distanceM = 150;
    const dLat = (Math.cos(radians) * distanceM) / 111_320;
    const dLon = (Math.sin(radians) * distanceM) / (111_320 * Math.cos(((lat as number) * Math.PI) / 180));
    L.polyline([start, [start[0] + dLat, start[1] + dLon]], { color: '#ffcf66', weight: 2 })
      .bindTooltip(`Observed bearing ${degrees}° ±${String(uncertainty ?? '?')}°`)
      .addTo(layers.bearings);
  }
}

export function drawTargetReference(target: TargetProfile | undefined, layers: FinderLayers): void {
  layers.reference.clearLayers();
  if (!target?.lastKnown) return;
  const tooltip = document.createElement('span');
  tooltip.textContent = `${target.lastKnown.label} — self-reported reference, not a current or exact position`;
  L.circleMarker([target.lastKnown.lat, target.lastKnown.lon], {
    radius: 8,
    color: '#62b6ff',
    fillColor: '#62b6ff',
    fillOpacity: 0.25,
    weight: 2,
    dashArray: '3 3',
  }).bindTooltip(tooltip).addTo(layers.reference);
}
