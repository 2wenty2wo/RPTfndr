export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function formatSignal(value: number | undefined, unit: string): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(value % 1 ? 1 : 0)} ${unit}`;
}

export function formatAge(t: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - t) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

export function icon(name: 'radio' | 'target' | 'pulse' | 'map' | 'log' | 'menu'): string {
  const paths = {
    radio: '<path d="M4 9h16M7 13h10M10 17h4M12 4v16"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15"/>',
    log: '<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  } as const;
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[name]}</svg>`;
}

export function emptyState(title: string, body: string, action?: string): string {
  return `<div class="empty-state"><div class="empty-rings" aria-hidden="true"></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>${action ? `<button class="button primary" data-action="${escapeHtml(action)}">Get started</button>` : ''}</div>`;
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
