import type { GpsFix, Reception, SearchSession } from '../types';

export const RECEPTION_CSV_COLUMNS = [
  'session_id',
  'target_id',
  'time',
  'latitude',
  'longitude',
  'gps_accuracy_m',
  'gps_age_ms',
  'speed_mps',
  'heading_deg',
  'rssi_dbm',
  'snr_db',
  'uplink_snr_db',
  'packet_hash',
  'packet_type',
  'origin',
  'immediate_tx',
  'path',
  'classification',
  'explanation',
  'raw_frame_hex',
  'raw_lora_hex',
  'decoder_version',
  'app_version',
  'simulated_data',
] as const;

export type ReceptionCsvColumn = typeof RECEPTION_CSV_COLUMNS[number];
export type CsvScalar = string | number | boolean | null | undefined;

export interface ReceptionCsvInput {
  session: SearchSession;
  receptions: readonly Reception[];
  fixes?: readonly GpsFix[];
}

export interface ParsedReceptionCsv {
  header: string[];
  rows: Array<Record<string, string>>;
  simulatedData: boolean | undefined;
  reviewOnly: true;
}

export class CsvParseError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} at character ${offset}`);
    this.name = 'CsvParseError';
  }
}

export function escapeCsvField(value: CsvScalar): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const escapeCsvValue = escapeCsvField;

export function stringifyCsv(rows: readonly (readonly CsvScalar[])[]): string {
  return rows.map((row) => row.map(escapeCsvField).join(',')).join('\r\n');
}

export const buildCsv = stringifyCsv;

/** RFC 4180 parser, including escaped quotes and embedded CR/LF fields. */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length === 0) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
    justClosedQuote = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length > 0 || justClosedQuote) throw new CsvParseError('Unexpected quote', index);
      quoted = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\r' || character === '\n') {
      pushRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      if (justClosedQuote) throw new CsvParseError('Unexpected character after closing quote', index);
      field += character;
    }
  }
  if (quoted) throw new CsvParseError('Unterminated quoted field', text.length);
  if (field.length > 0 || row.length > 0 || text.endsWith(',')) pushRow();
  return rows;
}

export function parseCsvLine(line: string): string[] {
  const rows = parseCsv(line);
  if (rows.length > 1) throw new CsvParseError('CSV line contains more than one record');
  return rows[0] ?? [];
}

export function splitCsvRecords(text: string): string[] {
  if (text.length === 0) return [];
  const records: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (character === '\r' || character === '\n')) {
      records.push(text.slice(start, index));
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      start = index + 1;
    }
  }
  if (quoted) throw new CsvParseError('Unterminated quoted field', text.length);
  records.push(text.slice(start));
  return records;
}

export function buildReceptionCsv(input: ReceptionCsvInput): string {
  const fixById = new Map<number, GpsFix>();
  for (const fix of input.fixes ?? []) {
    if (fix.id !== undefined) fixById.set(fix.id, fix);
  }
  const rows: CsvScalar[][] = [[...RECEPTION_CSV_COLUMNS]];
  for (const reception of input.receptions) {
    const fix = reception.gps.fixId === undefined ? undefined : fixById.get(reception.gps.fixId);
    rows.push([
      input.session.id,
      input.session.targetSnapshot.id,
      new Date(reception.t).toISOString(),
      reception.gps.lat,
      reception.gps.lon,
      reception.gps.accuracy,
      reception.gps.ageMs,
      fix?.speed,
      fix?.heading,
      reception.rssi,
      reception.snr,
      reception.uplinkSnr,
      reception.decoded?.hashHex,
      reception.decoded?.payloadTypeName ?? (reception.decodeError ? 'Decode failed' : ''),
      formatOrigin(reception),
      reception.cls.immediateTx?.hashHex,
      reception.decoded?.path.join('>'),
      reception.cls.kind,
      reception.cls.explanation,
      reception.frameHex,
      reception.loraHex,
      input.session.app.decoderVersion,
      input.session.app.version,
      input.session.demo,
    ]);
  }
  return stringifyCsv(rows);
}

export function parseReceptionCsv(text: string): ParsedReceptionCsv {
  const records = parseCsv(text);
  if (records.length === 0) throw new CsvParseError('CSV is empty');
  const header = records[0]!;
  const required = ['session_id', 'time', 'classification', 'raw_frame_hex'];
  for (const column of required) {
    if (!header.includes(column)) throw new CsvParseError(`Missing required column "${column}"`);
  }
  const rows: Array<Record<string, string>> = [];
  for (let rowIndex = 1; rowIndex < records.length; rowIndex += 1) {
    const record = records[rowIndex]!;
    if (record.every((value) => value === '')) continue;
    if (record.length !== header.length) {
      throw new CsvParseError(`Row ${rowIndex + 1} has ${record.length} fields; expected ${header.length}`);
    }
    const row: Record<string, string> = {};
    header.forEach((column, index) => { row[column] = record[index]!; });
    if (!Number.isFinite(Date.parse(row.time ?? ''))) throw new CsvParseError(`Row ${rowIndex + 1} has an invalid time`);
    if (!/^(?:[0-9a-f]{2})+$/i.test(row.raw_frame_hex ?? '')) {
      throw new CsvParseError(`Row ${rowIndex + 1} has invalid raw frame hex`);
    }
    rows.push(row);
  }
  const simulationValues = new Set(rows.map((row) => row.simulated_data).filter(Boolean));
  let simulatedData: boolean | undefined;
  if (simulationValues.size > 1) throw new CsvParseError('CSV mixes simulated and real rows');
  const simulationValue = [...simulationValues][0];
  if (simulationValue !== undefined) {
    if (simulationValue !== 'true' && simulationValue !== 'false') {
      throw new CsvParseError('simulated_data must be true or false');
    }
    simulatedData = simulationValue === 'true';
  }
  // CSV imports are deliberately review-only. Only the JSON archive contains
  // enough typed metadata to restore a session without inventing data.
  return { header, rows, simulatedData, reviewOnly: true };
}

function formatOrigin(reception: Reception): string {
  const origin = reception.cls.origin;
  if (!origin) return '';
  return origin.pubkeyHex ?? origin.srcHashHex ?? origin.name ?? '';
}
