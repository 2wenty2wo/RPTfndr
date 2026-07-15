export const THEMES = ['night', 'light', 'contrast'] as const;
export type Theme = (typeof THEMES)[number];

export function currentTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return THEMES.includes(value as Theme) ? (value as Theme) : 'night';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('mcf-theme', theme);
  } catch {
    // The selected theme still applies for the current page.
  }
  const color = theme === 'light' ? '#edf4ef' : theme === 'contrast' ? '#000000' : '#07130f';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}
