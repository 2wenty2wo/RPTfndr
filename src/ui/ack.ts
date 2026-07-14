import { WORDING } from '../app/wording';

export function acknowledgementHtml(): string {
  return `<div class="modal-backdrop" role="presentation">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="ack-title">
      <span class="eyebrow">Before you begin</span>
      <h1 id="ack-title">${WORDING.safetyTitle}</h1>
      <p class="muted">${WORDING.safetyBody}</p>
      <ul class="ack-list">
        <li>This estimates a search area from relative radio signal observations; it does not reveal an exact location.</li>
        <li>Forwarded and ambiguous packets are recorded separately and never influence the finder gauge or search area.</li>
        <li>Your logs, location fixes, targets, and exports stay on this device unless you choose to export them.</li>
      </ul>
      <label class="toggle card"><span><strong>I understand and am authorised to search</strong><br><small class="muted">Required once on this device</small></span><input id="ack-check" type="checkbox" /></label>
      <button class="button primary" data-action="acknowledge" disabled>Continue</button>
    </section>
  </div>`;
}

export function bindAcknowledgement(root: ParentNode): void {
  const check = root.querySelector<HTMLInputElement>('#ack-check');
  const button = root.querySelector<HTMLButtonElement>('[data-action="acknowledge"]');
  check?.addEventListener('change', () => {
    if (button) button.disabled = !check.checked;
  });
}
