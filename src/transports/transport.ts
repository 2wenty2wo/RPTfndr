import type { ConnState, Transport } from '../types';

export type TransportDataMode = 'real' | 'simulated';

/**
 * Additional metadata implemented by all built-in transports. The core
 * Transport interface deliberately stays small; this marker is what prevents
 * replay/mock frames from being appended to a real field session.
 */
export interface ModeAwareTransport extends Transport {
  readonly dataMode: TransportDataMode;
}

export type FrameListener = (frame: Uint8Array) => void;
export type StateListener = (state: ConnState) => void;

export class TransportModeError extends Error {
  constructor(
    readonly transportMode: TransportDataMode,
    readonly sessionIsDemo: boolean,
  ) {
    super(
      transportMode === 'simulated'
        ? 'Simulated transport data cannot be recorded in a real session.'
        : 'Real transport data cannot be recorded in a demo session.',
    );
    this.name = 'TransportModeError';
  }
}

export function isModeAwareTransport(transport: Transport): transport is ModeAwareTransport {
  return 'dataMode' in transport
    && ((transport as Partial<ModeAwareTransport>).dataMode === 'real'
      || (transport as Partial<ModeAwareTransport>).dataMode === 'simulated');
}

export function transportDataMode(transport: Transport): TransportDataMode {
  // Unknown/custom transports are treated as real. This fail-closed default
  // means they can never accidentally enter a demo archive as simulated data.
  return isModeAwareTransport(transport) ? transport.dataMode : 'real';
}

export function assertTransportSessionCompatibility(
  transport: Transport,
  sessionOrDemo: { demo: boolean } | boolean,
): void {
  const sessionIsDemo = typeof sessionOrDemo === 'boolean' ? sessionOrDemo : sessionOrDemo.demo;
  const mode = transportDataMode(transport);
  if ((mode === 'simulated') !== sessionIsDemo) {
    throw new TransportModeError(mode, sessionIsDemo);
  }
}

/** Shared listener plumbing for transport implementations. */
export abstract class ObservableTransport implements ModeAwareTransport {
  abstract readonly kind: Transport['kind'];
  abstract readonly capabilities: Transport['capabilities'];
  abstract readonly dataMode: TransportDataMode;

  protected currentState: ConnState = 'disconnected';
  private readonly frameListeners = new Set<FrameListener>();
  private readonly stateListeners = new Set<StateListener>();

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract write(bytes: Uint8Array): Promise<void>;

  get state(): ConnState {
    return this.currentState;
  }

  onFrame(callback: FrameListener): () => void {
    this.frameListeners.add(callback);
    return () => this.frameListeners.delete(callback);
  }

  onState(callback: StateListener): () => void {
    this.stateListeners.add(callback);
    callback(this.currentState);
    return () => this.stateListeners.delete(callback);
  }

  protected emitFrame(frame: Uint8Array): void {
    // A notification is one complete companion frame. Give every consumer an
    // independent copy so a parser cannot mutate data seen by another listener.
    for (const listener of this.frameListeners) listener(frame.slice());
  }

  protected emitState(state: ConnState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  protected clearListeners(): void {
    this.frameListeners.clear();
    this.stateListeners.clear();
  }
}

export function isMobileBrowser(navigatorLike: Pick<Navigator, 'userAgent'> & {
  userAgentData?: { mobile?: boolean };
  platform?: string;
  maxTouchPoints?: number;
}): boolean {
  if (navigatorLike.userAgentData?.mobile === true) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigatorLike.userAgent)) return true;
  // iPadOS can identify itself as Macintosh while touch-capable.
  return navigatorLike.platform === 'MacIntel' && (navigatorLike.maxTouchPoints ?? 0) > 1;
}
