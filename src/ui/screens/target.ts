import type { AppState } from '../../app/store';
import { emptyState, escapeHtml } from '../components';

export function targetScreen(state: Readonly<AppState>): string {
  const current = state.activeSession?.targetSnapshot ?? state.activeTarget;
  const locked = Boolean(state.activeSession);
  const targets = state.targets.map((target) => `<button class="card target-choice ${target.id === current?.id ? 'accent' : ''}" data-action="select-target" data-id="${escapeHtml(target.id)}" ${locked ? 'disabled title="End the active session before switching target"' : ''}>
    <span class="row"><strong>${escapeHtml(target.label)}</strong><span class="classification ${target.identity.kind === 'full-pubkey' ? 'direct' : 'ambiguous'}">${escapeHtml(target.identity.kind)}</span></span>
    <span class="code muted">${escapeHtml(target.identity.pubkeyHex ?? target.identity.bytesHex ?? target.identity.name ?? '')}</span>
  </button>`).join('');
  const prefix = (current?.identity.pubkeyHex ?? current?.identity.bytesHex)?.toLowerCase();
  const observed = new Map<string, Set<string>>();
  const addObserved = (pubkey: string | undefined, name?: string): void => {
    const normalized = pubkey?.toLowerCase();
    if (!normalized || !/^[0-9a-f]{64}$/.test(normalized)) return;
    const names = observed.get(normalized) ?? new Set<string>();
    if (name?.trim()) names.add(name.trim());
    observed.set(normalized, names);
  };
  for (const target of state.targets) {
    if (target.source === 'contacts') {
      addObserved(target.identity.pubkeyHex, target.identity.name ?? target.label);
    }
  }
  for (const reception of state.receptions) {
    addObserved(reception.decoded?.advert?.pubkeyHex, reception.decoded?.advert?.name);
    addObserved(reception.decoded?.anonSenderPubkeyHex);
    addObserved(reception.cls.origin?.pubkeyHex, reception.cls.origin?.name);
  }
  const pinCandidates = current?.identity.kind === 'name-only'
    ? (() => {
        const expectedName = current.identity.name?.trim();
        if (!expectedName) return [];
        const matches = [...observed.entries()].filter(([, names]) =>
          [...names].some((name) => name.localeCompare(expectedName, undefined, { sensitivity: 'accent' }) === 0),
        );
        return matches.length === 1 ? [matches[0]?.[0]].filter((value): value is string => Boolean(value)) : [];
      })()
    : [...observed.keys()].filter((pubkey) => !prefix || pubkey.startsWith(prefix));
  pinCandidates.sort();
  return `<section class="screen" aria-labelledby="target-title">
    <div class="screen-header"><div><span class="eyebrow">Step 2 · Identity</span><h1 id="target-title">Choose the target</h1><p>A full 32-byte public key is strongest. A node ID (first 4 bytes) may confirm only when no known identity collides; shorter prefixes never produce confirmed samples.</p></div></div>
    <div class="grid two">
      <div class="stack">
        <h2>Saved and observed targets</h2>
        ${targets || emptyState('No targets saved', 'Sync repeater contacts after connecting, or add a known public key/node ID.', undefined)}
      </div>
      <form class="card stack" data-form="target">
        <h2>Add target manually</h2>
        <label class="field"><span>Label</span><input name="label" autocomplete="off" required maxlength="64" placeholder="Hilltop repeater" /></label>
        <label class="field"><span>Public key, node ID, or prefix</span><input name="identity" class="code" autocomplete="off" required pattern="(?:[0-9a-fA-F]{2}){1,32}" placeholder="8–64 hexadecimal characters preferred" /></label>
        <label class="field"><span>Notes (optional)</span><textarea name="notes" maxlength="500" placeholder="Asset tag, install notes, access constraints"></textarea></label>
        <button class="button primary" type="submit">Save target</button>
        <p class="fine-print">Hex input is normalised. You can pin a matching full-key advert or contact later; identity changes are recorded in the session log.</p>
      </form>
    </div>
    ${current && current.identity.kind !== 'full-pubkey' ? `<article class="card stack" style="margin-top:.85rem"><div><h2>Pin an observed full key</h2><p class="muted">Only keys actually decoded or synced from contacts are offered. During an active session, pinning records an identity-change event and reclassifies stored receptions.</p></div>${pinCandidates.length ? pinCandidates.map((pubkey) => `<div class="row"><span class="code">${escapeHtml(pubkey)}</span><button class="button" data-action="pin-target" data-pubkey="${escapeHtml(pubkey)}">Pin full key</button></div>`).join('') : '<p class="fine-print">No matching full-key advert, anonymous sender, or synced contact has been observed yet.</p>'}</article>` : ''}
    ${current ? `<div class="card accent row" style="margin-top:.85rem"><div><strong>Active: ${escapeHtml(current.label)}</strong><p>${locked ? 'Target is locked for this session except for verified full-key pinning.' : 'Ready to create a walk or drive session.'}</p></div><a class="button primary" href="#/finder">Continue</a></div>` : ''}
  </section>`;
}
