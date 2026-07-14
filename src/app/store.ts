import type { SignalSnapshot } from '../signal';
import { DEFAULT_SESSION_SETTINGS } from '../types';
import type { AreaEstimate, CellAggregate, ConnState, GpsFix, Reception, SearchSession, SessionEvent, SessionSettings, TargetProfile } from '../types';

export interface Notice {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  message: string;
  action?: { label: string; run: () => void };
}

export interface AppState {
  ready: boolean;
  route: string;
  acknowledged: boolean;
  connection: ConnState;
  transportKind: 'webbluetooth' | 'mock' | 'replay' | null;
  deviceName?: string;
  device?: SearchSession['device'];
  targets: TargetProfile[];
  activeTarget?: TargetProfile;
  sessions: SearchSession[];
  activeSession?: SearchSession;
  resumeCandidate?: SearchSession;
  receptions: Reception[];
  fixes: GpsFix[];
  events: SessionEvent[];
  estimate?: AreaEstimate;
  cells: CellAggregate[];
  signal?: SignalSnapshot;
  preferences: SessionSettings;
  writer: boolean;
  gpsState: 'good' | 'degraded' | 'searching' | 'denied' | 'unavailable';
  mapAvailable: boolean;
  notices: Notice[];
  updateAvailable: boolean;
}

type Subscriber<T> = (state: Readonly<T>, previous: Readonly<T>) => void;

export class Store<T extends object> {
  readonly #subscribers = new Set<Subscriber<T>>();
  #state: T;

  constructor(initial: T) {
    this.#state = initial;
  }

  get value(): Readonly<T> {
    return this.#state;
  }

  set(patch: Partial<T> | ((current: Readonly<T>) => Partial<T>)): void {
    const previous = this.#state;
    const changes = typeof patch === 'function' ? patch(previous) : patch;
    this.#state = { ...previous, ...changes };
    for (const subscriber of this.#subscribers) subscriber(this.#state, previous);
  }

  subscribe(subscriber: Subscriber<T>, immediate = true): () => void {
    this.#subscribers.add(subscriber);
    if (immediate) subscriber(this.#state, this.#state);
    return () => this.#subscribers.delete(subscriber);
  }
}

export const initialAppState: AppState = {
  ready: false,
  route: 'connect',
  acknowledged: false,
  connection: 'disconnected',
  transportKind: null,
  targets: [],
  sessions: [],
  receptions: [],
  fixes: [],
  events: [],
  cells: [],
  preferences: { ...DEFAULT_SESSION_SETTINGS },
  writer: true,
  gpsState: 'searching',
  mapAvailable: true,
  notices: [],
  updateAvailable: false,
};
