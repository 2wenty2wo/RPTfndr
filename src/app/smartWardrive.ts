export interface SmartWardriveConfig {
  enabled: boolean;
  autoDiscovery: boolean;
  discoveryIntervalMs: number;
  observerAssist: boolean;
  observerPollIntervalMs: number;
}

export interface SmartWardriveSnapshot {
  active: boolean;
  reason: string;
  nextDiscoveryAt?: number;
  nextObserverPollAt?: number;
  discoveryRuns: number;
  observerPollRuns: number;
  lastError?: string;
}

export interface SmartWardriveSchedulerOptions {
  onDiscovery: () => Promise<void>;
  onObserverPoll: () => Promise<void>;
  onUpdate?: (snapshot: SmartWardriveSnapshot) => void;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  initialDiscoveryDelayMs?: number;
  initialObserverDelayMs?: number;
}

const MIN_DISCOVERY_INTERVAL_MS = 60_000;
const MIN_OBSERVER_INTERVAL_MS = 5 * 60_000;

/**
 * Foreground scheduler for explicitly enabled, rate-limited RF work. The
 * controller owns all eligibility checks and stops this scheduler whenever a
 * session, connection, target, or page-visibility prerequisite is lost.
 */
export class SmartWardriveScheduler {
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly initialDiscoveryDelayMs: number;
  private readonly initialObserverDelayMs: number;
  private timer?: ReturnType<typeof globalThis.setTimeout>;
  private generation = 0;
  private config?: SmartWardriveConfig;
  private state: SmartWardriveSnapshot = {
    active: false,
    reason: 'Smart Wardrive is disabled.',
    discoveryRuns: 0,
    observerPollRuns: 0,
  };

  constructor(private readonly options: SmartWardriveSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.initialDiscoveryDelayMs = Math.max(0, options.initialDiscoveryDelayMs ?? 10_000);
    this.initialObserverDelayMs = Math.max(0, options.initialObserverDelayMs ?? 20_000);
  }

  start(config: SmartWardriveConfig): void {
    this.clearTimer();
    this.generation += 1;
    this.config = {
      ...config,
      discoveryIntervalMs: Math.max(MIN_DISCOVERY_INTERVAL_MS, config.discoveryIntervalMs),
      observerPollIntervalMs: Math.max(MIN_OBSERVER_INTERVAL_MS, config.observerPollIntervalMs),
    };
    if (!config.enabled || (!config.autoDiscovery && !config.observerAssist)) {
      this.setState({
        active: false,
        reason: config.enabled
          ? 'Enable automatic discovery or observer assist to run Smart Wardrive.'
          : 'Smart Wardrive is disabled.',
        nextDiscoveryAt: undefined,
        nextObserverPollAt: undefined,
        lastError: undefined,
      });
      return;
    }
    const now = this.now();
    this.setState({
      active: true,
      reason: 'Foreground automation is active.',
      nextDiscoveryAt: config.autoDiscovery ? now + this.initialDiscoveryDelayMs : undefined,
      nextObserverPollAt: config.observerAssist ? now + this.initialObserverDelayMs : undefined,
      lastError: undefined,
    });
    this.schedule(this.generation);
  }

  stop(reason = 'Smart Wardrive stopped.'): void {
    this.clearTimer();
    this.generation += 1;
    this.config = undefined;
    this.setState({
      active: false,
      reason,
      nextDiscoveryAt: undefined,
      nextObserverPollAt: undefined,
    });
  }

  snapshot(): SmartWardriveSnapshot {
    return { ...this.state };
  }

  private schedule(generation: number): void {
    if (!this.state.active || generation !== this.generation) return;
    const due = [this.state.nextDiscoveryAt, this.state.nextObserverPollAt]
      .filter((value): value is number => value !== undefined);
    if (!due.length) return;
    const delay = Math.max(0, Math.min(...due) - this.now());
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      void this.runDue(generation);
    }, delay);
  }

  private async runDue(generation: number): Promise<void> {
    const config = this.config;
    if (!config || !this.isCurrentRun(generation, config)) return;
    const now = this.now();
    let lastError: string | undefined;
    if (config.autoDiscovery && (this.state.nextDiscoveryAt ?? Number.POSITIVE_INFINITY) <= now) {
      let completed = false;
      try {
        await this.options.onDiscovery();
        if (!this.isCurrentRun(generation, config)) return;
        completed = true;
      } catch (error) {
        if (!this.isCurrentRun(generation, config)) return;
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (completed) {
        this.setState({ discoveryRuns: this.state.discoveryRuns + 1 });
      }
      if (!this.isCurrentRun(generation, config)) return;
      this.setState({ nextDiscoveryAt: this.now() + config.discoveryIntervalMs });
      if (!this.isCurrentRun(generation, config)) return;
    }
    if (config.observerAssist && (this.state.nextObserverPollAt ?? Number.POSITIVE_INFINITY) <= this.now()) {
      let completed = false;
      try {
        await this.options.onObserverPoll();
        if (!this.isCurrentRun(generation, config)) return;
        completed = true;
      } catch (error) {
        if (!this.isCurrentRun(generation, config)) return;
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (completed) {
        this.setState({ observerPollRuns: this.state.observerPollRuns + 1 });
      }
      if (!this.isCurrentRun(generation, config)) return;
      this.setState({ nextObserverPollAt: this.now() + config.observerPollIntervalMs });
      if (!this.isCurrentRun(generation, config)) return;
    }
    if (lastError) this.setState({ lastError });
    if (!this.isCurrentRun(generation, config)) return;
    this.schedule(generation);
  }

  private isCurrentRun(generation: number, config: SmartWardriveConfig): boolean {
    return generation === this.generation && this.config === config && this.state.active;
  }

  private setState(patch: Partial<SmartWardriveSnapshot>): void {
    this.state = { ...this.state, ...patch };
    this.options.onUpdate?.(this.snapshot());
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }
}
