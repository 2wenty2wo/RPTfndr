import type { RouteName } from '../app/router';
import { icon } from './components';

const ITEMS: Array<{ route: RouteName; label: string; icon: Parameters<typeof icon>[0] }> = [
  { route: 'connect', label: 'Radio', icon: 'radio' },
  { route: 'target', label: 'Target', icon: 'target' },
  { route: 'finder', label: 'Finder', icon: 'pulse' },
  { route: 'map', label: 'Map', icon: 'map' },
  { route: 'sessions', label: 'Logs', icon: 'log' },
];

export function navHtml(active: string): string {
  return `<nav class="bottom-nav" aria-label="Primary">${ITEMS.map(({ route, label, icon: iconName }) =>
    `<a href="#/${route}" ${active === route ? 'aria-current="page"' : ''}>${icon(iconName)}<span>${label}</span></a>`).join('')}</nav>`;
}
