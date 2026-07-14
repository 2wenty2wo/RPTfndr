import { ObservableTransport, isMobileBrowser } from './transport';

export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_WRITE_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_NOTIFY_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

export const MESHCORE_REQUEST_OPTIONS: RequestDeviceOptions = {
  filters: [{ namePrefix: 'MeshCore' }, { namePrefix: 'Meshtastic' }],
  optionalServices: [NUS_SERVICE_UUID],
};

type BluetoothWithDevices = Pick<Bluetooth, 'requestDevice'> & {
  getDevices?: () => Promise<BluetoothDevice[]>;
};

export interface WebBluetoothTransportOptions {
  /** Injected for tests; defaults to navigator.bluetooth. */
  bluetooth?: BluetoothWithDevices;
  /** Unexpected drops reconnect only when this and silentReconnect are true. */
  autoReconnect?: boolean;
  requestOptions?: RequestDeviceOptions;
  gattAttempts?: number;
  reconnectAttempts?: number;
  watchdogMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export class WebBluetoothUnavailableError extends Error {
  constructor() {
    super('Web Bluetooth is unavailable. Use a compatible HTTPS browser such as Bluefy on iPhone.');
    this.name = 'WebBluetoothUnavailableError';
  }
}

export class WebBluetoothTransport extends ObservableTransport {
  readonly kind = 'webbluetooth' as const;
  readonly dataMode = 'real' as const;
  readonly capabilities: { silentReconnect: boolean };

  private readonly bluetooth?: BluetoothWithDevices;
  private readonly requestOptions: RequestDeviceOptions;
  private readonly autoReconnect: boolean;
  private readonly gattAttempts: number;
  private readonly reconnectAttempts: number;
  private readonly watchdogMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  private device?: BluetoothDevice;
  private writeCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private notifyCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private watchdog?: ReturnType<typeof globalThis.setInterval>;
  private reconnectGeneration = 0;
  private reconnecting = false;
  private intentionalDisconnect = false;

  private readonly handleValueChanged = (event: Event): void => {
    const characteristic = event.target as BluetoothRemoteGATTCharacteristic | null;
    const value = characteristic?.value;
    if (!value) return;
    this.emitFrame(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };

  private readonly handleGattDisconnected = (): void => {
    void this.handleUnexpectedDisconnect();
  };

  constructor(options: WebBluetoothTransportOptions = {}) {
    super();
    const nav = typeof navigator === 'undefined' ? undefined : navigator;
    this.bluetooth = options.bluetooth ?? nav?.bluetooth;
    this.requestOptions = options.requestOptions ?? MESHCORE_REQUEST_OPTIONS;
    this.autoReconnect = options.autoReconnect ?? true;
    this.gattAttempts = Math.max(1, options.gattAttempts ?? 3);
    this.reconnectAttempts = Math.min(5, Math.max(0, options.reconnectAttempts ?? 5));
    this.watchdogMs = Math.max(250, options.watchdogMs ?? 3_000);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      globalThis.setTimeout(resolve, milliseconds);
    }));
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);

    const getDevices = typeof this.bluetooth?.getDevices === 'function';
    const mobile = nav ? isMobileBrowser(nav) : false;
    this.capabilities = { silentReconnect: getDevices && !mobile };
    if (!this.bluetooth) this.currentState = 'unsupported';
  }

  get connectedDevice(): BluetoothDevice | undefined {
    return this.device;
  }

  async connect(): Promise<void> {
    if (!this.bluetooth) {
      this.emitState('unsupported');
      throw new WebBluetoothUnavailableError();
    }

    this.reconnectGeneration += 1;
    this.reconnecting = false;
    this.intentionalDisconnect = false;
    await this.cleanupLink(false);

    this.emitState('requesting');
    let device: BluetoothDevice;
    try {
      // This is the only code path allowed to open a picker. Callers must invoke
      // connect() from a user gesture as required by Web Bluetooth.
      device = await this.bluetooth.requestDevice(this.requestOptions);
    } catch (error) {
      this.emitState('disconnected');
      throw error;
    }

    this.device = device;
    this.emitState('connecting');
    try {
      await this.establish(device);
    } catch (error) {
      await this.cleanupLink(true);
      this.emitState('disconnected');
      throw error;
    }
  }

  /**
   * Reconnect an already-authorised device without a picker. This never falls
   * back to requestDevice(), so it is safe outside a user gesture.
   */
  async connectAuthorized(deviceId: string): Promise<boolean> {
    if (!this.capabilities.silentReconnect || !this.bluetooth?.getDevices) return false;
    const devices = await this.bluetooth.getDevices();
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) return false;
    this.reconnectGeneration += 1;
    this.intentionalDisconnect = false;
    this.device = device;
    this.emitState('connecting');
    try {
      await this.establish(device);
      return true;
    } catch (error) {
      await this.cleanupLink(false);
      this.emitState('disconnected');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.reconnectGeneration += 1;
    this.reconnecting = false;
    const device = this.device;
    await this.cleanupLink(true);
    if (device?.gatt?.connected) {
      try {
        device.gatt.disconnect();
      } catch {
        // The browser can race a physical disconnect with this call.
      }
    }
    this.device = undefined;
    this.intentionalDisconnect = false;
    this.emitState('disconnected');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.currentState !== 'connected' || !this.writeCharacteristic) {
      throw new Error('Cannot write: Web Bluetooth transport is not connected.');
    }
    // Copy to an ArrayBuffer-backed view for strict BufferSource typings and to
    // prevent caller mutation while the browser queues the write.
    const value = Uint8Array.from(bytes);
    await this.writeCharacteristic.writeValueWithoutResponse(value);
  }

  private async establish(device: BluetoothDevice): Promise<void> {
    const gatt = device.gatt;
    if (!gatt) throw new Error('The selected Bluetooth device does not expose GATT.');

    let service: BluetoothRemoteGATTService | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.gattAttempts; attempt += 1) {
      try {
        const server = await gatt.connect();
        service = await server.getPrimaryService(NUS_SERVICE_UUID);
        break;
      } catch (error) {
        lastError = error;
        if (isInvalidStateError(error) || attempt === this.gattAttempts) break;
        await this.sleep(attempt * 500);
      }
    }
    if (!service) throw asError(lastError, 'Unable to connect to the MeshCore UART service.');

    // Register only after connect/service discovery. A late disconnect event
    // from an old GATT session must not abort this connection attempt.
    device.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    device.addEventListener('gattserverdisconnected', this.handleGattDisconnected);

    try {
      const writeCharacteristic = await service.getCharacteristic(NUS_WRITE_UUID);
      const notifyCharacteristic = await service.getCharacteristic(NUS_NOTIFY_UUID);
      try {
        await notifyCharacteristic.stopNotifications();
      } catch {
        // Chrome may report no active notification pipe on a fresh connection.
      }
      await notifyCharacteristic.startNotifications();
      notifyCharacteristic.addEventListener('characteristicvaluechanged', this.handleValueChanged);
      this.writeCharacteristic = writeCharacteristic;
      this.notifyCharacteristic = notifyCharacteristic;
      this.startWatchdog();
      this.emitState('connected');
    } catch (error) {
      device.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
      throw error;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = this.setIntervalFn(() => {
      if (this.device && this.device.gatt?.connected === false) {
        void this.handleUnexpectedDisconnect();
      }
    }, this.watchdogMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) this.clearIntervalFn(this.watchdog);
    this.watchdog = undefined;
  }

  private async handleUnexpectedDisconnect(): Promise<void> {
    if (this.intentionalDisconnect || this.reconnecting) return;
    const deviceId = this.device?.id;
    await this.cleanupLink(false);

    if (!deviceId || !this.autoReconnect || !this.capabilities.silentReconnect) {
      this.device = undefined;
      this.emitState('disconnected');
      return;
    }

    this.reconnecting = true;
    const generation = ++this.reconnectGeneration;
    this.emitState('reconnecting');
    try {
      for (let attempt = 0; attempt < this.reconnectAttempts; attempt += 1) {
        const delayMs = Math.min(8_000, 2_000 * (2 ** attempt));
        await this.sleep(delayMs);
        if (generation !== this.reconnectGeneration || this.intentionalDisconnect) return;

        try {
          const devices = await this.bluetooth?.getDevices?.();
          const device = devices?.find((candidate) => candidate.id === deviceId);
          if (!device) continue;
          this.device = device;
          await this.establish(device);
          return;
        } catch {
          await this.cleanupLink(false);
          if (generation === this.reconnectGeneration) this.emitState('reconnecting');
        }
      }
      if (generation === this.reconnectGeneration) {
        this.device = undefined;
        this.emitState('disconnected');
      }
    } finally {
      if (generation === this.reconnectGeneration) this.reconnecting = false;
    }
  }

  private async cleanupLink(removeDisconnectListener: boolean): Promise<void> {
    this.stopWatchdog();
    const notify = this.notifyCharacteristic;
    this.notifyCharacteristic = undefined;
    this.writeCharacteristic = undefined;

    notify?.removeEventListener('characteristicvaluechanged', this.handleValueChanged);
    if (notify) {
      try {
        await notify.stopNotifications();
      } catch {
        // Disconnected GATT objects normally reject here; cleanup still proceeds.
      }
    }
    if (removeDisconnectListener && this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleGattDisconnected);
    }
  }
}

function isInvalidStateError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'InvalidStateError'
    : typeof error === 'object' && error !== null && 'name' in error
      && (error as { name?: unknown }).name === 'InvalidStateError';
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
