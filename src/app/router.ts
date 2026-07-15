export const ROUTES = [
  'connect',
  'target',
  'finder',
  'df',
  'map',
  'sessions',
  'session',
  'discovery',
  'diagnostics',
  'settings',
  'privacy',
  'compat',
] as const;

export type RouteName = (typeof ROUTES)[number];

export interface Route {
  name: RouteName;
  params: URLSearchParams;
}

export class HashRouter {
  #listener?: () => void;

  current(): Route {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path = '', query = ''] = raw.split('?');
    const name = ROUTES.includes(path as RouteName) ? (path as RouteName) : 'connect';
    return { name, params: new URLSearchParams(query) };
  }

  navigate(name: RouteName, params?: Record<string, string>): void {
    const query = params ? new URLSearchParams(params).toString() : '';
    location.hash = `#/${name}${query ? `?${query}` : ''}`;
  }

  start(listener: (route: Route) => void): () => void {
    this.#listener = () => listener(this.current());
    addEventListener('hashchange', this.#listener);
    this.#listener();
    return () => {
      if (this.#listener) removeEventListener('hashchange', this.#listener);
      this.#listener = undefined;
    };
  }
}
