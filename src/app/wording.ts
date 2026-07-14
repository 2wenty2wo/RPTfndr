export const WORDING = {
  estimateTitle: 'Strongest confirmed search area',
  estimateBasis: 'Based on relative signal strength from provably direct target transmissions. This is not an exact position.',
  morePasses: 'More passes are needed before a search area can be estimated.',
  moreCells: 'Collect confirmed receptions from more places and directions.',
  noConfirmed: 'No provably direct target transmissions have been heard yet.',
  staleSignal: 'Signal is stale — keep moving and wait for another confirmed reception.',
  direct: 'Confirmed direct target transmission',
  forwarded: 'Target-origin packet heard through another transmitter — excluded from location calculations',
  ambiguous: 'Possible target match, but the available identity is ambiguous — excluded from location calculations',
  unknown: 'Immediate transmitter cannot be proven — excluded from location calculations',
  safetyTitle: 'Search responsibly',
  safetyBody: 'Use this tool only for equipment you own or are authorised to recover. Stay on public land or obtain permission, obey local laws, and never confront another person.',
  technicalLog: 'Technical search log',
} as const;

export type WordingKey = keyof typeof WORDING;
