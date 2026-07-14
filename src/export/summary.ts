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
  lines.push(
    '',
    'Interpretation limits',
    'Relative RSSI/SNR observations can help narrow a search area. Reflections, antenna orientation, terrain, obstructions, radio power, and GPS error can all change the readings.',
    'This technical search log does not identify or claim an exact transmitter position.',
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
