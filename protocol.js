// Decoder for the HS30A BLE notification stream. See protocol.py for the field notes.
//
// Every frame is: fe <length> <type> <payload...> <checksum>
// `length` counts the whole frame. `checksum` is the low byte of the sum of all bytes
// after the 0xFE header, excluding the checksum itself.

const HEADER = 0xfe;
const TYPE_STATUS = 0x55;
const TYPE_WAVE = 0x56;
const MIN_FRAME_LENGTH = 4;
const MAX_FRAME_LENGTH = 32;

function parse(frame) {
  const kind = frame[2];
  if (kind === TYPE_WAVE && frame.length === 8) {
    return { kind: "wave", value: frame[3], seq: frame[6] };
  }
  if (kind === TYPE_STATUS && frame.length === 10) {
    return {
      kind: "status",
      heartRate: frame[4],
      spo2: frame[5],
      perfusionRaw: (frame[6] << 8) | frame[7],
    };
  }
  return { kind: "unknown", raw: frame };
}

/** Reassembles frames from notifications, which may split or merge them. */
export class FrameDecoder {
  #buffer = [];
  droppedBytes = 0;

  feed(bytes) {
    const buffer = this.#buffer;
    buffer.push(...bytes);
    const frames = [];
    let start = 0;

    while (start < buffer.length) {
      if (buffer[start] !== HEADER) {
        start += 1;
        this.droppedBytes += 1;
        continue;
      }
      if (buffer.length - start < 2) break;
      const length = buffer[start + 1];
      if (length < MIN_FRAME_LENGTH || length > MAX_FRAME_LENGTH) {
        start += 1;
        this.droppedBytes += 1;
        continue;
      }
      if (buffer.length - start < length) break;

      let sum = 0;
      for (let i = start + 1; i < start + length - 1; i++) sum += buffer[i];
      if ((sum & 0xff) !== buffer[start + length - 1]) {
        start += 1;
        this.droppedBytes += 1;
        continue;
      }
      frames.push(parse(buffer.slice(start, start + length)));
      start += length;
    }

    buffer.splice(0, start);
    return frames;
  }
}

function plausible(value, low, high) {
  return value >= low && value <= high ? value : null;
}

/** The reading stored and shown for a status frame; implausible values become null. */
export function makeRecord(frame, timestampMs) {
  return {
    ts: Math.round(timestampMs),
    spo2: plausible(frame.spo2, 50, 100),
    hr: plausible(frame.heartRate, 25, 250),
    pi: frame.perfusionRaw || null,
  };
}
