import type { ClassificationKind } from '../types';
import type { SessionArchiveV1 } from './json';

export function buildTechnicalSummary(archive: SessionArchiveV1): string {
  const session = archive.session;
  const endedAt = session.endedAt ?? archive.receptions.at(-1)?.t;
  const located = archive.receptions.filter((reception) => reception.gps.status === 'ok').length;
  const confirmed = archive.receptions.filter((reception) => reception.cls.confirmed);
  const confirmedLocated = confirmed.filter((reception) => reception.gps.status === 'ok').length;
  const classifications = countClassifications(archive);
  const best = confirmed.reduce<(typeof confirmed)[number] | undefined>((current, reception) => (
    !current || reception.rssi > current.rssi ? reception : current
  ), undefined);
  const acceptedFixes = archive.fixes.filter((fix) => fix.accepted).length;
  const rejectedFixes = archive.fixes.length - acceptedFixes;
  const estimate = archive.derived?.estimate;
  const bearingConsensus = archive.derived?.bearingConsensus;
  const finalApproach = archive.derived?.finalApproach;
  const remoteObservers = archive.derived?.remoteObserverAnalysis;
  const remoteZone = remoteObservers?.zone;
  const communityAssistedZone = archive.derived?.communityAssistedZone;
  const targetPubkeyHex = session.targetSnapshot.identity.kind === 'full-pubkey'
    ? session.targetSnapshot.identity.pubkeyHex?.toLowerCase()
    : undefined;
  const remoteReportCount = targetPubkeyHex === undefined
    ? 0
    : archive.events.filter((event) => (
        event.type === 'observer-evidence'
        && event.data.source === 'guest-neighbour'
        && event.data.trust === 'verified-observer'
        && typeof event.data.targetPubkeyHex === 'string'
        && event.data.targetPubkeyHex.toLowerCase() === targetPubkeyHex
      )).length;
  const importedObserverAuditCount = archive.events.filter((event) => (
    event.type === 'note'
    && event.data.kind === 'imported-observer-evidence-audit'
    && event.data.eligibility === 'audit-only'
    && event.data.originalEventType === 'observer-evidence'
  )).length;

  const lines = [
    'MeshCore Finder technical search log',
    '====================================',
    '',
  ];
  if (archive.simulatedData) {
    lines.push('SIMULATED DATA — this log was produced by demo/replay tooling, not live radio reception.', '');
  }
  lines.push(
    `Session: ${session.title}`,
    `Session ID: ${session.id}`,
    `Target profile: ${session.targetSnapshot.label} (${session.targetSnapshot.id})`,
    `Mode: ${session.mode}`,
    `Started: ${formatTime(session.startedAt)}`,
    `Ended: ${endedAt === undefined ? 'not recorded' : formatTime(endedAt)}`,
    `Exported: ${archive.exportedAt}`,
    `App / decoder: ${session.app.version} / ${session.app.decoderVersion}`,
    '',
    'Capture totals',
    `- Receptions recorded: ${archive.receptions.length}`,
    `- Provably direct target receptions: ${confirmed.length}`,
    `- Confirmed receptions with usable location: ${confirmedLocated}`,
    `- All located receptions (including excluded classifications): ${located}`,
    `- GPS fixes accepted / rejected: ${acceptedFixes} / ${rejectedFixes}`,
    '',
    'Classification breakdown',
  );
  for (const [kind, count] of classifications) lines.push(`- ${kind}: ${count}`);
  lines.push('', 'Signal observations');
  if (best) {
    lines.push(
      `- Strongest confirmed reception: ${best.rssi} dBm, ${formatDecimal(best.snr)} dB SNR at ${formatTime(best.t)}`,
      `- Location attached: ${best.gps.status === 'ok' ? `yes (reported accuracy ${formatDecimal(best.gps.accuracy)} m)` : 'no'}`,
    );
  } else {
    lines.push('- No provably direct target reception was recorded.');
  }
  lines.push('', 'Search-area estimate');
  if (estimate?.ready) {
    lines.push(
      `- Strongest confirmed search area: ${formatDecimal(estimate.areaM2)} m²`,
      `- Confidence: ${estimate.confidence ?? 'not assigned'}`,
      `- Based on ${estimate.sampleCount} confirmed located samples across ${estimate.cellCount} cells.`,
      `- Method note: ${estimate.reason}`,
    );
  } else {
    lines.push(`- Not ready: ${estimate?.reason ?? 'No derived estimate was included in this archive.'}`);
  }
  lines.push('', 'Directional-bearing zone');
  if (bearingConsensus) {
    lines.push(
      '- Approximate: yes',
      `- Confidence / geometry: ${bearingConsensus.confidence} / ${bearingConsensus.geometryQuality}`,
      `- Contributing bearings: ${bearingConsensus.observationCount}`,
      `- Uncertainty radius: ${formatDecimal(bearingConsensus.radiusM)} m`,
      `- RMS cross-track error: ${formatDecimal(bearingConsensus.rmsCrossTrackErrorM)} m`,
    );
  } else {
    lines.push('- Not available: at least two eligible, separated directional bearings are required.');
  }
  lines.push('', 'Final-approach zone');
  if (finalApproach?.ready) {
    lines.push(
      '- Approximate: yes',
      `- Confidence: ${finalApproach.confidence}`,
      `- Area: ${formatDecimal(finalApproach.areaM2)} m²`,
      `- Inputs: ${finalApproach.bearingCount} bearings and ${finalApproach.signalCellCount} confirmed signal cells.`,
      `- Method note: ${finalApproach.reason}`,
    );
  } else if (finalApproach?.disagreement) {
    lines.push(
      '- Not produced: the bearing zone and confirmed-signal search area disagree.',
      `- Guidance: ${finalApproach.reason}`,
    );
  } else {
    lines.push(`- Not ready: ${finalApproach?.reason ?? 'No final-approach analysis was included in this archive.'}`);
  }
  lines.push('', 'Remote observer assist');
  lines.push(`- Target-matched guest neighbour reports: ${remoteReportCount}`);
  lines.push(`- Imported audit-only observer reports: ${importedObserverAuditCount}`);
  if (importedObserverAuditCount > 0) {
    lines.push('- Imported observer reports are retained for review but excluded from every location calculation.');
  }
  lines.push(`- Eligible fresh reports used in this analysis: ${remoteObservers?.eligibleObservationCount ?? 0}`);
  if (remoteObservers?.ready && remoteZone) {
    lines.push(
      '- Approximate: yes',
      `- Verified observers / reports: ${remoteZone.observerCount} / ${remoteZone.observationCount}`,
      `- Confidence / geometry: ${remoteZone.confidence} / ${remoteZone.geometryQuality}`,
      `- Area: ${formatDecimal(remoteZone.areaM2)} m²`,
      `- Relative-SNR constraints used: ${remoteZone.relativeConstraintCount}`,
      `- Terrain and fading allowance: ${formatDecimal(remoteZone.terrainUncertaintyDb)} dB`,
      '- Method note: observer SNR was used only as broad relative likelihood, never converted into a distance.',
    );
  } else {
    lines.push(`- Not ready: ${remoteObservers?.reason ?? 'No remote-observer analysis was included in this archive.'}`);
  }
  lines.push('', 'Community-assisted search zone');
  if (communityAssistedZone?.ready) {
    lines.push(
      '- Approximate: yes',
      `- Confidence: ${communityAssistedZone.confidence}`,
      `- Area: ${formatDecimal(communityAssistedZone.areaM2)} m²`,
      `- Verified observers: ${communityAssistedZone.observerCount}`,
      `- Method note: ${communityAssistedZone.reason}`,
    );
  } else if (communityAssistedZone?.disagreement) {
    lines.push(
      '- Not produced: the remote-observer and local search zones disagree.',
      `- Guidance: ${communityAssistedZone.reason}`,
    );
  } else {
    lines.push(`- Not ready: ${communityAssistedZone?.reason ?? 'No combined remote/local analysis was included in this archive.'}`);
  }
  lines.push(
    '',
    'Interpretation limits',
    'Relative RSSI/SNR observations can help narrow a search area. Reflections, antenna orientation, terrain, obstructions, radio power, and GPS error can all change the readings.',
    'Remote observer coordinates must be independently verified. Repeater-advertised or contact coordinates are not used in calculations.',
    'Every mapped zone is approximate. Close-range searching and visual confirmation are still required.',
  );
  return lines.join('\n');
}

export const buildSummary = buildTechnicalSummary;

function countClassifications(archive: SessionArchiveV1): Array<[ClassificationKind, number]> {
  const counts = new Map<ClassificationKind, number>();
  for (const reception of archive.receptions) {
    counts.set(reception.cls.kind, (counts.get(reception.cls.kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatTime(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : 'not recorded';
}

function formatDecimal(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'not recorded' : value.toFixed(1);
}
