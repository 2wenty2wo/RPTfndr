import type { ObserverRuntimeStatus } from '../app/store';
import type { AreaEstimate, GpsFix, VerifiedObserver } from '../types';
import type { BearingConsensusAnalysis, BearingExclusion, FinalApproachEstimate } from './bearings';
import { distanceMeters, type LatLon } from './geo';
import type { RemoteObserverAnalysis, RemoteObserverExclusion } from './remoteObservers';

const MAX_OBSERVER_ANCHOR_ACCURACY_M = 250;

export type NextObservationActionKind =
  | 'collect-confirmed-samples'
  | 'take-separated-bearing'
  | 'sample-polygon-edge'
  | 'poll-verified-observer'
  | 'different-approach-pass'
  | 'close-range-visual-search';

export interface NextObservationAction {
  kind: NextObservationActionKind;
  title: string;
  detail: string;
  score: number;
  evidence: string[];
  target?: LatLon;
  observerId?: string;
}

export interface NextObservationInput {
  estimate?: AreaEstimate;
  finalApproach?: FinalApproachEstimate;
  bearingAnalysis?: BearingConsensusAnalysis;
  remoteObserverAnalysis?: RemoteObserverAnalysis;
  bearingExclusions?: readonly BearingExclusion[];
  remoteExclusions?: readonly RemoteObserverExclusion[];
  observers?: readonly VerifiedObserver[];
  observerStatuses?: readonly ObserverRuntimeStatus[];
  recentGpsTrack?: readonly GpsFix[];
  maxActions?: number;
  now?: number;
}

function centroid(points: readonly [number, number][]): LatLon | undefined {
  if (points.length === 0) return undefined;
  return {
    lat: points.reduce((sum, [lat]) => sum + lat, 0) / points.length,
    lon: points.reduce((sum, [, lon]) => sum + lon, 0) / points.length,
  };
}

function farthestVertex(points: readonly [number, number][], track: readonly GpsFix[]): LatLon | undefined {
  if (points.length === 0) return undefined;
  const accepted = track.filter((fix) => fix.accepted);
  if (accepted.length === 0) return { lat: points[0]![0], lon: points[0]![1] };
  return points
    .map(([lat, lon]) => {
      const point = { lat, lon };
      const nearestTrackM = Math.min(...accepted.map((fix) => distanceMeters(point, fix)));
      return { point, nearestTrackM };
    })
    .sort((a, b) => b.nearestTrackM - a.nearestTrackM)[0]?.point;
}

function recentTrackSpanM(track: readonly GpsFix[]): number {
  const accepted = track.filter((fix) => fix.accepted);
  if (accepted.length < 2) return 0;
  let span = 0;
  for (let index = 1; index < accepted.length; index += 1) {
    span += distanceMeters(accepted[index - 1]!, accepted[index]!);
  }
  return span;
}

function hasReason<T extends { reason: string }>(items: readonly T[], reason: string): boolean {
  return items.some((item) => item.reason === reason);
}

function statusPriority(status: ObserverRuntimeStatus | undefined): number {
  if (!status) return 35;
  if (status.state === 'queued' || status.state === 'querying') return 0;
  if (status.state === 'matched') return 10;
  if (status.state === 'idle' || status.state === 'no-match') return 45;
  if (status.state === 'error') return 25;
  return 5;
}

export function recommendNextObservations(input: NextObservationInput): NextObservationAction[] {
  const actions: NextObservationAction[] = [];
  const estimate = input.estimate;
  const finalApproach = input.finalApproach;
  const bearingAnalysis = input.bearingAnalysis;
  const bearingExclusions = input.bearingExclusions ?? bearingAnalysis?.exclusions ?? [];
  const remote = input.remoteObserverAnalysis;
  const remoteExclusions = input.remoteExclusions ?? remote?.exclusions ?? [];
  const track = input.recentGpsTrack ?? [];

  if (!estimate?.ready || estimate.sampleCount === 0) {
    actions.push({
      kind: 'collect-confirmed-samples',
      title: 'collect confirmed direct samples first',
      detail: 'No confirmed RSSI search polygon is ready, so collect direct target receptions with accepted GPS before using geometry guidance.',
      score: 100,
      evidence: [`confirmed samples: ${estimate?.sampleCount ?? 0}`, estimate?.reason ?? 'no estimate yet'],
    });
  }

  if (estimate?.ready && estimate.polygon) {
    const edge = farthestVertex(estimate.polygon, track);
    const span = recentTrackSpanM(track);
    actions.push({
      kind: 'sample-polygon-edge',
      title: 'walk/drive through this weakly sampled edge of the polygon',
      detail: 'The farthest polygon edge from the recent accepted GPS track should tighten the RSSI hull and test whether the strong area extends there.',
      score: span < 100 ? 86 : 68,
      evidence: [`polygon area: ${Math.round(estimate.areaM2 ?? 0).toLocaleString()} m²`, `recent accepted track span: ${Math.round(span)} m`],
      ...(edge ? { target: edge } : {}),
    });
  }

  const needsSeparatedBearing =
    !finalApproach?.ready ||
    hasReason(bearingExclusions, 'near-parallel') ||
    hasReason(bearingExclusions, 'insufficient-separation');
  if (needsSeparatedBearing) {
    actions.push({
      kind: 'take-separated-bearing',
      title: 'take a bearing from this separated area',
      detail: hasReason(bearingExclusions, 'near-parallel')
        ? 'Recent bearings are near-parallel; move sideways relative to the suspected target area and record a crossing angle.'
        : 'A separated bearing gives directional geometry that can overlap the confirmed RSSI search area.',
      score: hasReason(bearingExclusions, 'near-parallel') ? 95 : 76,
      evidence: [`eligible bearings: ${bearingAnalysis?.eligibleObservationCount ?? finalApproach?.bearingCount ?? 0}`, finalApproach?.reason ?? bearingAnalysis?.reason ?? 'bearing geometry not ready'],
      ...(estimate?.polygon ? { target: centroid(estimate.polygon) } : {}),
    });
  }

  const disagreement = Boolean(finalApproach?.disagreement || hasReason(remoteExclusions, 'inconsistent-relative-signal'));
  if (remote && (!remote.ready || disagreement || remote.eligibleObserverCount > 0)) {
    const byId = new Map(input.observerStatuses?.map((status) => [status.observerId, status]));
    const observer = (input.observers ?? [])
      .filter((candidate) => candidate.enabled && candidate.permissionConfirmed && candidate.accuracyM <= MAX_OBSERVER_ANCHOR_ACCURACY_M)
      .map((candidate) => ({ candidate, priority: statusPriority(byId.get(candidate.id)) }))
      .sort((a, b) => b.priority - a.priority)[0]?.candidate;
    actions.push({
      kind: 'poll-verified-observer',
      title: 'poll this verified observer next',
      detail: remote.ready && !disagreement
        ? 'A fresh verified observer poll can confirm whether community-assisted evidence still agrees with local observations.'
        : 'Remote-observer evidence is incomplete or disagreeing; query a permitted verified observer before relying on the assisted zone.',
      score: disagreement ? 90 : 62,
      evidence: [`eligible remote observers: ${remote.eligibleObserverCount}`, remote.reason],
      ...(observer ? { observerId: observer.id, target: observer } : {}),
    });
  }

  if (estimate?.ready && estimate.confidence !== 'high' && track.length > 0) {
    actions.push({
      kind: 'different-approach-pass',
      title: 'collect another pass from a different approach direction',
      detail: 'The RSSI area is not high confidence yet; approach from another direction to reduce route bias and multipath.',
      score: 72,
      evidence: [`RSSI confidence: ${estimate.confidence ?? 'unknown'}`, `cells used: ${estimate.cellsUsed?.length ?? 0}`],
      ...(estimate.polygon ? { target: centroid(estimate.polygon) } : {}),
    });
  }

  if (finalApproach?.ready && !finalApproach.disagreement && (finalApproach.areaM2 ?? Infinity) <= 10_000 && finalApproach.confidence !== 'low') {
    actions.push({
      kind: 'close-range-visual-search',
      title: 'start close-range visual search in the shaded zone',
      detail: 'The final-approach zone is small and consistent with confirmed signal evidence; visually verify equipment rather than treating the map as an exact marker.',
      score: 98,
      evidence: [`final area: ${Math.round(finalApproach.areaM2 ?? 0).toLocaleString()} m²`, `confidence: ${finalApproach.confidence}`],
      ...(finalApproach.polygon ? { target: centroid(finalApproach.polygon) } : {}),
    });
  }

  return actions
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, input.maxActions ?? 4);
}
