// Alarm rules for the monitor page. No DOM access, so it can be tested under node.

export const WARNING = 1;
export const CRITICAL = 2;

const CLEAR_HOLD_MS = 3000;
const LOG_LIMIT = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  spo2: Object.freeze({ enabled: true, low1: 92, low2: 88 }),
  pr: Object.freeze({ enabled: true, low1: 50, low2: 40, high1: 120, high2: 150 }),
  delaySeconds: 5,
  sound: true,
  technicalSound: false,
});

const PARAMS = {
  spo2: { name: "血氧", unit: "%", field: "spo2" },
  pr: { name: "脉率", unit: " 次/分", field: "hr" },
};

const LEVEL_NAMES = { [WARNING]: "一级", [CRITICAL]: "二级" };

export function cloneSettings(settings = DEFAULT_SETTINGS) {
  return {
    ...settings,
    spo2: { ...settings.spo2 },
    pr: { ...settings.pr },
  };
}

/** Lists problems in plain language; an empty list means the settings can be saved. */
export function validateSettings(settings) {
  const { spo2, pr, delaySeconds } = settings;
  const limits = [spo2.low1, spo2.low2, pr.low1, pr.low2, pr.high1, pr.high2];
  if (limits.some((value) => !Number.isFinite(value))) return ["请填写全部限值"];

  const errors = [];
  if (spo2.low1 > 100 || spo2.low2 < 50) errors.push("血氧限值应在 50 到 100 之间");
  if (spo2.low2 >= spo2.low1) errors.push("血氧二级限值应低于一级限值");
  if (pr.low2 < 25 || pr.high2 > 250) errors.push("脉率限值应在 25 到 250 之间");
  if (pr.low2 >= pr.low1) errors.push("脉率下限的二级限值应低于一级限值");
  if (pr.high2 <= pr.high1) errors.push("脉率上限的二级限值应高于一级限值");
  if (pr.low1 >= pr.high1) errors.push("脉率一级下限应低于一级上限");
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0) errors.push("报警延迟无效");
  return errors;
}

/** Restores saved settings, falling back to defaults if they are missing or invalid. */
export function restoreSettings(saved) {
  if (!saved || typeof saved !== "object") return cloneSettings();
  const merged = {
    ...cloneSettings(),
    ...saved,
    spo2: { ...DEFAULT_SETTINGS.spo2, ...saved.spo2 },
    pr: { ...DEFAULT_SETTINGS.pr, ...saved.pr },
  };
  return validateSettings(merged).length ? cloneSettings() : merged;
}

export function classify(param, value, settings) {
  const limits = settings[param];
  if (value < limits.low2) return { level: CRITICAL, direction: "low", limit: limits.low2 };
  if (value < limits.low1) return { level: WARNING, direction: "low", limit: limits.low1 };
  if (param === "pr") {
    if (value > limits.high2) return { level: CRITICAL, direction: "high", limit: limits.high2 };
    if (value > limits.high1) return { level: WARNING, direction: "high", limit: limits.high1 };
  }
  return { level: 0, direction: null, limit: null };
}

export function alarmMessage(alarm) {
  const { name, unit } = PARAMS[alarm.param];
  const direction = alarm.direction === "low" ? "过低" : "过高";
  const relation = alarm.direction === "low" ? "低于" : "高于";
  return `${name}${direction} ${alarm.value}${unit}，${relation}${LEVEL_NAMES[alarm.level]}限值 ${alarm.limit}`;
}

export function levelName(level) {
  return LEVEL_NAMES[level];
}

function freshState() {
  return { level: 0, since: { [WARNING]: null, [CRITICAL]: null }, clearSince: null, entry: null };
}

/**
 * Tracks each parameter over time. A level is raised only after the reading has stayed
 * past its limit for the delay, which filters out finger-movement artefacts. It is lowered
 * only after a short hold, so a value hovering on a limit doesn't flood the log.
 */
export class AlarmEngine {
  constructor(settings = cloneSettings(), log = []) {
    this.settings = settings;
    this.log = log;
    this.states = { spo2: freshState(), pr: freshState() };
    this.latest = {};
  }

  setSettings(settings) {
    this.settings = settings;
  }

  /** @param reading {spo2, hr}, where null means no valid value */
  update(reading, now) {
    for (const param of Object.keys(PARAMS)) {
      const value = reading?.[PARAMS[param].field] ?? null;
      this.latest[param] = value;
      if (value == null || !this.settings[param].enabled) {
        this.#clear(param, now);
      } else {
        this.#evaluate(param, value, now);
      }
    }
    return this.active();
  }

  /** Current alarms, most severe first. */
  active() {
    const alarms = [];
    for (const param of Object.keys(PARAMS)) {
      const state = this.states[param];
      if (state.level) {
        alarms.push({
          param,
          level: state.level,
          direction: state.direction,
          limit: state.limit,
          value: this.latest[param],
          startedAt: state.entry.startedAt,
        });
      }
    }
    return alarms.sort((a, b) => b.level - a.level);
  }

  #evaluate(param, value, now) {
    const state = this.states[param];
    const current = classify(param, value, this.settings);
    const delay = this.settings.delaySeconds * 1000;

    let target = 0;
    for (const level of [WARNING, CRITICAL]) {
      if (current.level >= level) {
        state.since[level] ??= now;
        if (now - state.since[level] >= delay) target = level;
      } else {
        state.since[level] = null;
      }
    }

    if (target > state.level) {
      state.level = target;
      state.direction = current.direction;
      state.limit = current.limit;
      state.clearSince = null;
      if (state.entry) {
        state.entry.peakLevel = target;
        state.entry.limit = current.limit;
      } else {
        state.entry = {
          param,
          peakLevel: target,
          direction: current.direction,
          limit: current.limit,
          worst: value,
          startedAt: now,
          endedAt: null,
        };
        this.log.unshift(state.entry);
        this.log.length = Math.min(this.log.length, LOG_LIMIT);
      }
    }

    if (state.entry) {
      const pick = state.entry.direction === "low" ? Math.min : Math.max;
      state.entry.worst = pick(state.entry.worst, value);
    }

    if (current.level >= state.level) {
      state.clearSince = null;
    } else if (state.level) {
      state.clearSince ??= now;
      if (now - state.clearSince >= CLEAR_HOLD_MS) {
        state.level = target;
        state.clearSince = null;
        if (target) {
          state.limit = current.limit;
        } else {
          this.#finish(state, now);
        }
      }
    }
  }

  #clear(param, now) {
    const state = this.states[param];
    if (state.entry) this.#finish(state, now);
    this.states[param] = freshState();
  }

  #finish(state, now) {
    state.entry.endedAt = now;
    state.entry = null;
    state.direction = null;
    state.limit = null;
  }
}

/** Sound silencing. A worse alarm than the one silenced breaks through immediately. */
export class AudioPause {
  constructor() {
    this.until = 0;
    this.level = 0;
  }

  pause(now, currentLevel, durationMs) {
    this.until = now + durationMs;
    this.level = currentLevel;
  }

  resume() {
    this.until = 0;
    this.level = 0;
  }

  remainingMs(now, currentLevel) {
    if (now >= this.until) return 0;
    if (currentLevel > this.level && this.level !== 0) {
      this.resume();
      return 0;
    }
    return this.until - now;
  }
}
