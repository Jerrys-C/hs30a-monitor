// Data sources for the monitor page. Both report through the same callbacks:
//   onState(state, { detail, replay }), onWave([[seq, value], ...]), onStatus(record)

import { FrameDecoder, makeRecord } from "./protocol.js";

const DEVICE_NAME_PREFIX = "HS30A";
const SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb";
const NOTIFY_UUID = "0000ffe4-0000-1000-8000-00805f9b34fb";
const CONNECT_TIMEOUT_MS = 20000;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;

export function bluetoothSupport() {
  if (!window.isSecureContext) return "insecure";
  if (!navigator.bluetooth?.requestDevice) return "unsupported";
  return "ok";
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`连接超时（${ms / 1000} 秒）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connects this browser straight to the oximeter with Web Bluetooth. */
export class BleTransport {
  #handlers;
  #device = null;
  #characteristic = null;
  #decoder = new FrameDecoder();
  #wanted = false;
  #session = 0;

  constructor(handlers) {
    this.#handlers = handlers;
    this.#device = null;
    addEventListener("pagehide", () => this.disconnect());
  }

  /** Must run inside a click: browsers only show the device chooser for a user action. */
  async pick() {
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (error) {
      // Cancelling the chooser and a missing adapter share the name NotFoundError.
      if (error.name === "NotFoundError" && /cancel/i.test(error.message)) {
        this.#handlers.onState("idle", {});
        return;
      }
      console.warn("requestDevice failed", error);
      this.#handlers.onState("error", { detail: error.message });
      return;
    }

    this.#device?.removeEventListener("gattserverdisconnected", this.#onDisconnected);
    this.#device = device;
    device.addEventListener("gattserverdisconnected", this.#onDisconnected);
    this.#wanted = true;
    this.#handlers.onState("connecting", {});
    await this.#keepTrying();
  }

  disconnect() {
    this.#wanted = false;
    this.#session += 1;
    this.#stopNotifications();
    if (this.#device?.gatt?.connected) this.#device.gatt.disconnect();
    this.#handlers.onState("idle", {});
  }

  #onDisconnected = () => {
    if (!this.#wanted) return;
    this.#stopNotifications();
    this.#handlers.onState("reconnecting", {});
    this.#keepTrying();
  };

  /** Retries until connected or the user disconnects; a new session cancels an older one. */
  async #keepTrying() {
    const session = ++this.#session;
    let delay = RETRY_MIN_MS;
    while (this.#wanted && session === this.#session) {
      try {
        await withTimeout(this.#connectOnce(), CONNECT_TIMEOUT_MS);
        if (session !== this.#session) return;
        this.#handlers.onState("connected", {});
        return;
      } catch (error) {
        if (session !== this.#session) return;
        console.warn("BLE connect failed", error);
        this.#handlers.onState("reconnecting", { detail: error.message });
        if (this.#device?.gatt?.connected) this.#device.gatt.disconnect();
      }
      await wait(delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    }
  }

  async #connectOnce() {
    const server = await this.#device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(NOTIFY_UUID);
    this.#decoder = new FrameDecoder();
    characteristic.addEventListener("characteristicvaluechanged", this.#onValue);
    this.#characteristic = characteristic;
    await characteristic.startNotifications();
  }

  #stopNotifications() {
    this.#characteristic?.removeEventListener("characteristicvaluechanged", this.#onValue);
    this.#characteristic = null;
  }

  #onValue = (event) => {
    const view = event.target.value;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const batch = [];
    for (const frame of this.#decoder.feed(bytes)) {
      if (frame.kind === "wave") batch.push([frame.seq, frame.value]);
      else if (frame.kind === "status") this.#handlers.onStatus(makeRecord(frame, Date.now()));
      else console.info("未知帧", frame.raw);
    }
    if (batch.length) this.#handlers.onWave(batch);
  };
}

/** Reads from the local Python service (server.py), used on this Mac and for replay tests. */
export class BridgeTransport {
  #handlers;

  constructor(handlers) {
    this.#handlers = handlers;
    this.#open();
  }

  #open() {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      switch (message.t) {
        case "wave":
          this.#handlers.onWave(message.d);
          break;
        case "status":
          this.#handlers.onStatus(message);
          break;
        case "history":
          this.#handlers.onHistory(message.d);
          break;
        case "state":
          this.#handlers.onState(message.state, { detail: message.detail, replay: message.replay });
          break;
      }
    };
    socket.onclose = () => {
      this.#handlers.onState("bridge-down", {});
      setTimeout(() => this.#open(), 1500);
    };
  }
}
