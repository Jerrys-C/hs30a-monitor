import {
  AlarmEngine,
  AudioPause,
  CRITICAL,
  WARNING,
  alarmMessage,
  cloneSettings,
  levelName,
  restoreSettings,
  validateSettings,
} from "./alarms.js";
import { RecordStore } from "./storage.js";
import { BleTransport, BridgeTransport, bluetoothSupport } from "./transport.js";

const HZ = 50;
const STALE_MS = 4000;
const GAP_MS = 5000;
const SILENCE_MS = 2 * 60 * 1000;
const MAX_RECORDS = 24 * 60 * 60;
const BLUEFY_URL = "https://apps.apple.com/app/id1492822055";
const TREND_WINDOWS = [
  { label: "10 分钟", ms: 10 * 60 * 1000 },
  { label: "1 小时", ms: 60 * 60 * 1000 },
  { label: "8 小时", ms: 8 * 60 * 60 * 1000 },
];
const SOUND_INTERVAL_MS = { tech: 30000, [WARNING]: 15000, [CRITICAL]: 5000 };
const COLORS = {
  spo2: "#27D8F0",
  spo2Trace: "#16A3BD",
  prTrace: "#25AE58",
  warning: "#FFD21F",
  critical: "#FF3B30",
  line: "#27313A",
  soft: "#94A3AF",
  ground: "#000000",
};
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const bridgeMode = new URLSearchParams(location.search).has("bridge");

function loadStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows can block storage; settings then last for this visit only.
  }
}

const app = {
  state: "starting",
  detail: null,
  replay: false,
  lastWaveAt: 0,
  lastStatusAt: 0,
  latest: null,
  everMonitored: false,
  records: [],
  trendWindow: TREND_WINDOWS[0],
  settings: restoreSettings(loadStored("hs30a.settings", null)),
};
const engine = new AlarmEngine(app.settings, loadStored("hs30a.alarmLog", []));
const pause = new AudioPause();

/* ---------- Waveform sweep ---------- */
const canvas = $("trace");
const ctx = canvas.getContext("2d");
const wave = {
  width: 0, height: 0, samples: 0,
  ring: new Float32Array(0), head: 0,
  queue: [], lastSeq: null, carry: 0, taps: [],
  low: 0, high: 100,
  prev: NaN, rising: false, lastBeat: 0,
};
const ERASE_SAMPLES = 14;
const TOP_PAD = 34;
const BOTTOM_PAD = 24;

function resizeWave() {
  const box = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr);
  canvas.height = Math.round(box.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wave.width = box.width;
  wave.height = box.height;
  const seconds = Math.min(8, Math.max(3, box.width / 160));
  const samples = Math.round(seconds * HZ);
  if (samples !== wave.samples) {
    wave.samples = samples;
    wave.ring = new Float32Array(samples).fill(NaN);
    wave.head = 0;
  }
}

function enqueueWave(batch) {
  app.lastWaveAt = performance.now();
  for (const [seq, value] of batch) {
    if (wave.lastSeq !== null) {
      const missing = (seq - wave.lastSeq - 1 + 256) % 256;
      if (missing > 0 && missing < 50) {
        for (let i = 0; i < missing; i++) wave.queue.push(NaN);
      }
    }
    wave.lastSeq = seq;
    wave.queue.push(value);
  }
  // A hidden tab stops drawing; skip what it missed instead of fast-forwarding.
  if (wave.queue.length > HZ * 3) wave.queue.splice(0, wave.queue.length - HZ / 2);
}

function advance(raw) {
  wave.taps.push(raw);
  if (wave.taps.length > 3) wave.taps.shift();
  const [a, b, c] = wave.taps;
  // The device repeats most samples, so a short filter removes visible stair steps.
  const value = wave.taps.length < 3 || Number.isNaN(a + b + c) ? raw : (a + 2 * b + c) / 4;

  wave.ring[wave.head] = value;
  wave.head = (wave.head + 1) % wave.samples;
  for (let i = 0; i < ERASE_SAMPLES; i++) {
    wave.ring[(wave.head + i) % wave.samples] = NaN;
  }
  detectBeat(value);
}

function detectBeat(value) {
  const threshold = wave.low + (wave.high - wave.low) * 0.6;
  if (value > wave.prev) {
    wave.rising = true;
  } else if (wave.rising && value < wave.prev) {
    wave.rising = false;
    const now = performance.now();
    if (wave.prev > threshold && now - wave.lastBeat > 350) {
      wave.lastBeat = now;
      if (!reducedMotion) {
        $("heart").animate(
          [{ transform: "scale(1.5)" }, { transform: "scale(1)" }],
          { duration: 260, easing: "ease-out" },
        );
      }
    }
  }
  wave.prev = value;
}

function drawWave() {
  const { width, height, samples, ring, head } = wave;
  ctx.clearRect(0, 0, width, height);
  if (!samples) return;

  let min = Infinity;
  let max = -Infinity;
  for (const value of ring) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min !== Infinity) {
    const middle = (min + max) / 2;
    const span = Math.max(max - min, 24);
    wave.low += (middle - span / 2 - wave.low) * 0.04;
    wave.high += (middle + span / 2 - wave.high) * 0.04;
  }

  const plotHeight = height - TOP_PAD - BOTTOM_PAD;
  const toX = (i) => (i / (samples - 1)) * width;
  const toY = (v) => TOP_PAD + (1 - (v - wave.low) / (wave.high - wave.low)) * plotHeight;

  // One tick per second makes the pulse interval readable without a full grid.
  ctx.strokeStyle = COLORS.soft;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let s = 1; s * HZ < samples; s++) {
    const x = Math.round(toX(s * HZ)) + 0.5;
    ctx.moveTo(x, height - 4);
    ctx.lineTo(x, height - 11);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = COLORS.soft;
  ctx.font = "11px 'PingFang SC', sans-serif";
  ctx.fillText("每格 1 秒", 16, height - 6);

  ctx.strokeStyle = COLORS.spo2;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < samples; i++) {
    const value = ring[i];
    if (Number.isNaN(value)) { pen = false; continue; }
    if (pen) ctx.lineTo(toX(i), toY(value));
    else ctx.moveTo(toX(i), toY(value));
    pen = true;
  }
  ctx.stroke();

  const last = (head - 1 + samples) % samples;
  if (!Number.isNaN(ring[last])) {
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(toX(last), toY(ring[last]), 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

let lastFrame = performance.now();
let lastPaint = 0;
function tick(now) {
  const elapsed = Math.min(now - lastFrame, 250);
  lastFrame = now;
  const backlog = wave.queue.length;
  // Notifications arrive in bursts; a small buffer keeps the sweep at an even speed.
  const rate = backlog > HZ * 0.5 ? 1.25 : backlog < 4 ? 0.85 : 1;
  wave.carry += (elapsed / 1000) * HZ * rate;
  while (wave.carry >= 1 && wave.queue.length && wave.samples) {
    advance(wave.queue.shift());
    wave.carry -= 1;
  }
  if (!wave.queue.length) wave.carry = 0;
  if (!reducedMotion || now - lastPaint > 250) {
    drawWave();
    lastPaint = now;
  }
  requestAnimationFrame(tick);
}

/* ---------- Alarm sound ---------- */
let audio = null;
let soundKey = null;
let nextSoundAt = 0;

function unlockAudio() {
  audio ??= new AudioContext();
  if (audio.state === "suspended") audio.resume();
}

function beep(frequency, start, duration) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.35, start + 0.01);
  gain.gain.setValueAtTime(0.35, start + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration);
}

function playPattern(kind) {
  if (!audio || audio.state !== "running") return;
  const start = audio.currentTime + 0.02;
  if (kind === CRITICAL) {
    for (let i = 0; i < 5; i++) beep(988, start + i * 0.25, 0.15);
  } else if (kind === WARNING) {
    for (let i = 0; i < 3; i++) beep(659, start + i * 0.35, 0.2);
  } else {
    beep(523, start, 0.2);
  }
}

function runSound(level, technicalActive) {
  const now = Date.now();
  const wanted = level || (technicalActive && app.settings.technicalSound ? "tech" : null);
  const silenced = pause.remainingMs(now, level) > 0;
  if (!app.settings.sound || !wanted || silenced) {
    soundKey = null;
    return;
  }
  // A change of level sounds at once, then repeats at that level's interval.
  if (wanted !== soundKey || now >= nextSoundAt) {
    playPattern(wanted);
    soundKey = wanted;
    nextSoundAt = now + SOUND_INTERVAL_MS[wanted];
  }
}

/* ---------- Monitoring state ---------- */
function readingNow() {
  return performance.now() - app.lastStatusAt < STALE_MS ? app.latest : null;
}

function isAppleMobile() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** What the status bar and wave area should say for the current connection state. */
function technicalView() {
  const now = performance.now();
  if (app.replay && app.state === "connected") {
    return { connection: "回放", tone: "", alert: "回放示例数据，不是实时读数", silent: true };
  }
  switch (app.state) {
    case "unsupported": {
      const apple = isAppleMobile();
      return {
        connection: "无法连接", tone: "",
        alert: "这个浏览器不能连接蓝牙", silent: true,
        hint: {
          title: "这个浏览器不能连接蓝牙",
          body: apple
            ? "iPhone 和 iPad 上的 Safari、Chrome 都不支持网页蓝牙。请安装 Bluefy 浏览器，再用它打开这个网址。"
            : "请用电脑或安卓手机上的 Chrome 或 Edge 打开这个网址。",
          link: apple ? { href: BLUEFY_URL, text: "在 App Store 查看 Bluefy" } : null,
        },
      };
    }
    case "insecure":
      return {
        connection: "无法连接", tone: "",
        alert: "需要 HTTPS 才能连接蓝牙", silent: true,
        hint: { title: "需要 HTTPS 才能连接蓝牙", body: "请用 https:// 开头的网址打开这个页面。" },
      };
    case "idle":
      return {
        connection: "未连接", tone: "", alert: null,
        hint: {
          title: "连接血氧仪",
          body: "打开血氧仪并放入手指，点下面的按钮，在弹窗里选择 HS30A。",
          action: true,
        },
      };
    case "connecting":
      return {
        connection: "正在连接", tone: "",
        alert: app.everMonitored ? "正在重新连接血氧仪" : null,
        hint: { title: "正在连接血氧仪", body: "请保持血氧仪开机，并放在这台设备附近。" },
      };
    case "reconnecting":
      return {
        connection: "正在重连", tone: "",
        alert: "血氧仪已断开，正在重新连接",
        hint: { title: "正在重新连接血氧仪", body: "请确认血氧仪已开机、在附近，并且没有连接其他设备。" },
      };
    case "error":
      return {
        connection: "连接失败", tone: "",
        alert: "蓝牙连接失败",
        hint: {
          title: "蓝牙连接失败",
          body: "请确认蓝牙已打开、浏览器有蓝牙权限，并且血氧仪没有连接其他设备，然后再试一次。",
          action: bridgeMode ? false : true,
        },
      };
    case "bridge-down":
      return {
        connection: "服务已断开", tone: "",
        alert: "本地服务已断开",
        hint: { title: "本地服务没有运行", body: "在终端进入 hs30a-monitor 目录，运行 ./run.sh" },
      };
    case "searching":
      return {
        connection: "正在寻找", tone: "",
        alert: app.everMonitored ? "血氧仪已断开，正在寻找" : null,
        hint: { title: "正在寻找血氧仪", body: "请打开血氧仪并放入手指，并放在这台设备附近。" },
      };
    case "connected":
      if (now - app.lastWaveAt >= 2500) {
        return {
          connection: "已连接", tone: "live",
          alert: "未收到数据",
          hint: { title: "没有收到数据", body: "请确认手指已放入，血氧仪没有关机。" },
        };
      }
      if (now - app.lastStatusAt < STALE_MS && app.latest?.spo2 == null) {
        return {
          connection: "已连接", tone: "live",
          alert: "无有效读数",
          hint: { title: "正在等待稳定读数", body: "请放好手指，保持不动。" },
        };
      }
      return { connection: "已连接", tone: "live", alert: null };
    default:
      return { connection: "正在启动", tone: "", alert: null };
  }
}

function renderHint(view) {
  $("hint").hidden = !view;
  if (!view) return;
  $("hintTitle").textContent = view.title;
  $("hintBody").textContent = view.body;
  $("hintLink").hidden = !view.link;
  if (view.link) {
    $("hintLink").href = view.link.href;
    $("hintLink").textContent = view.link.text;
  }
  $("hintConnect").hidden = !view.action;
}

const CONNECTION_ACTIVE = new Set(["connecting", "connected", "reconnecting"]);

function renderConnectKey() {
  const key = $("connectKey");
  const usable = !bridgeMode && !["unsupported", "insecure", "starting"].includes(app.state);
  key.hidden = !usable;
  const text = CONNECTION_ACTIVE.has(app.state) ? "断开连接" : "连接血氧仪";
  if (key.textContent !== text) key.textContent = text;
}

function setSlot(slot, text, level, tag) {
  const key = `${level ?? ""}|${tag ?? ""}|${text}`;
  if (slot.dataset.key === key) return;
  slot.dataset.key = key;
  if (level) slot.dataset.level = level;
  else delete slot.dataset.level;
  slot.replaceChildren();
  if (tag) {
    const mark = document.createElement("span");
    mark.textContent = tag;
    slot.append(mark);
  }
  const body = document.createElement("span");
  body.textContent = text;
  slot.append(body);
}

function setValue(el, value) {
  const text = value ?? "--";
  if (el.textContent !== String(text)) el.textContent = text;
  el.classList.toggle("empty", value == null);
}

function setBlockLevel(block, level) {
  if (level) block.dataset.level = level;
  else delete block.dataset.level;
}

function renderLimits() {
  const { spo2, pr } = app.settings;
  const lines = (el, rows) => {
    el.replaceChildren(...rows.map(([text, off]) => {
      const row = document.createElement("div");
      row.textContent = text;
      if (off) row.className = "off";
      return row;
    }));
  };
  lines($("spo2Limits"), spo2.enabled
    ? [[`一级 < ${spo2.low1}`], [`二级 < ${spo2.low2}`]]
    : [["报警已关闭", true]]);
  lines($("prLimits"), pr.enabled
    ? [[`一级 ${pr.low1} 到 ${pr.high1}`], [`二级 ${pr.low2} 到 ${pr.high2}`]]
    : [["报警已关闭", true]]);
}

function renderSound(level) {
  const el = $("soundState");
  const remaining = pause.remainingMs(Date.now(), level);
  const button = $("silence");
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    el.textContent = `已静音 ${clock}`;
    el.dataset.tone = "caution";
    button.textContent = `恢复声音 ${clock}`;
    button.setAttribute("aria-pressed", "true");
    return;
  }
  button.textContent = "静音 2 分钟";
  button.setAttribute("aria-pressed", "false");
  if (!app.settings.sound) {
    el.textContent = "报警声音已关";
    el.dataset.tone = "caution";
  } else if (!audio || audio.state !== "running") {
    el.textContent = "点击页面启用声音";
    el.dataset.tone = "caution";
  } else {
    el.textContent = "报警声音开";
    el.dataset.tone = "";
  }
}

/** Runs on every reading and on a timer, so a silent device is still noticed. */
function render() {
  const reading = readingNow();
  const alarms = engine.update(reading, Date.now());
  saveLog();

  setValue($("spo2"), reading?.spo2);
  setValue($("pr"), reading?.hr);
  setValue($("pi"), reading?.pi != null ? (reading.pi / 1000).toFixed(2) : null);

  const worst = alarms[0];
  const level = worst?.level ?? 0;
  const levelOf = (param) => alarms.find((a) => a.param === param)?.level;
  setBlockLevel($("spo2Block"), levelOf("spo2"));
  setBlockLevel($("prBlock"), levelOf("pr"));

  if (worst) {
    const more = alarms.length > 1 ? `，另有 ${alarms.length - 1} 项报警` : "";
    setSlot($("physiological"), alarmMessage(worst) + more, level, `${levelName(level)} ${level === CRITICAL ? "◆" : "▲"}`);
  } else {
    const off = !app.settings.spo2.enabled && !app.settings.pr.enabled;
    setSlot($("physiological"), off ? "生理报警已关闭" : "报警监测中");
  }

  const view = technicalView();
  const connection = $("connection");
  if (connection.textContent !== view.connection) connection.textContent = view.connection;
  connection.dataset.tone = view.tone;
  if (view.alert) setSlot($("technical"), view.alert, "tech");
  else setSlot($("technical"), "设备状态正常");
  renderHint(view.hint);
  renderConnectKey();

  renderSound(level);
  runSound(level, Boolean(view.alert) && !view.silent);

  const titleText = worst ? `${levelName(level)}报警 ${alarmMessage(worst)}` : "HS30A 血氧监测";
  if (document.title !== titleText) document.title = titleText;
  $("clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  $("openLog").textContent = engine.log.length ? `报警记录 ${engine.log.length}` : "报警记录";
}

let savedLogKey = "";
function saveLog() {
  const key = engine.log.map((e) => `${e.startedAt}${e.endedAt}${e.worst}`).join();
  if (key === savedLogKey) return;
  savedLogKey = key;
  saveStored("hs30a.alarmLog", engine.log);
}

/* ---------- Trends ---------- */
const svgNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  parent.append(el);
  return el;
}

class Trend {
  constructor(root, { field, unit, color, domain, ticks, limits, statsEl, windowEl, summarize }) {
    Object.assign(this, { root, field, unit, color, domain, ticks, limits, statsEl, windowEl, summarize });
    this.hoverX = null;
    this.svg = svgEl("svg", { role: "img", tabindex: "0" }, root);
    this.tooltip = document.createElement("div");
    this.tooltip.className = "tooltip";
    this.tooltip.hidden = true;
    root.append(this.tooltip);
    this.svg.addEventListener("pointermove", (e) => {
      this.hoverX = e.clientX - this.svg.getBoundingClientRect().left;
      this.draw();
    });
    this.svg.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.draw();
    });
  }

  draw() {
    const { width, height } = this.svg.getBoundingClientRect();
    if (!width || !height) return;
    const margin = { left: 40, right: 16, top: 4, bottom: 18 };
    const span = app.trendWindow.ms;
    const now = Date.now();
    const start = now - span;
    const points = app.records.filter((r) => r.ts >= start && r[this.field] != null);
    const values = points.map((p) => p[this.field]);
    const [low, high] = this.domain(values);
    const x = (t) => margin.left + ((t - start) / span) * (width - margin.left - margin.right);
    const y = (v) => margin.top + (1 - (v - low) / (high - low)) * (height - margin.top - margin.bottom);

    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.replaceChildren();
    this.windowEl.textContent = `最近 ${app.trendWindow.label}`;

    for (const tick of this.ticks(low, high)) {
      svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), stroke: COLORS.line }, this.svg);
      svgEl("text", { x: 16, y: y(tick) + 4 }, this.svg).textContent = tick;
    }

    // Alarm limits are drawn in their tier colours, so distance to a limit reads at a glance.
    for (const { value, level } of this.limits()) {
      if (value < low || value > high) continue;
      svgEl("line", {
        x1: margin.left, x2: width - margin.right, y1: y(value), y2: y(value),
        stroke: level === CRITICAL ? COLORS.critical : COLORS.warning,
        "stroke-dasharray": "4 4",
        "stroke-opacity": 0.8,
      }, this.svg);
    }

    svgEl("text", { x: margin.left, y: height - 4 }, this.svg).textContent = `${app.trendWindow.label}前`;
    svgEl("text", { x: width - margin.right, y: height - 4, "text-anchor": "end" }, this.svg).textContent = "现在";

    const d = this.envelope(points, x, y, width - margin.left - margin.right);
    if (d) {
      svgEl("path", {
        d, fill: "none", stroke: this.color, "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }, this.svg);
    }

    this.statsEl.textContent = values.length ? this.summarize(values) : "";
    this.svg.setAttribute(
      "aria-label",
      values.length ? `最近 ${app.trendWindow.label}：${this.summarize(values)}` : `最近 ${app.trendWindow.label}没有数据`,
    );
    this.drawHover(points, x, y, width, height, margin);
  }

  /** Draws each 2 px bucket's lowest and highest value, so long windows can't hide a dip. */
  envelope(points, x, y, plotWidth) {
    const bucketMs = Math.max(1000, (app.trendWindow.ms / plotWidth) * 2);
    let d = "";
    let previousTs = null;
    let bucket = null;
    const flush = () => {
      if (!bucket) return;
      const px = x(bucket.ts).toFixed(1);
      d += `${bucket.broken ? "M" : "L"}${px} ${y(bucket.min).toFixed(1)}`;
      if (bucket.max !== bucket.min) d += `L${px} ${y(bucket.max).toFixed(1)}`;
    };
    for (const p of points) {
      const value = p[this.field];
      const broken = previousTs === null || p.ts - previousTs > Math.max(GAP_MS, bucketMs * 2);
      if (!bucket || broken || p.ts - bucket.ts >= bucketMs) {
        flush();
        bucket = { ts: p.ts, min: value, max: value, broken };
      } else {
        bucket.min = Math.min(bucket.min, value);
        bucket.max = Math.max(bucket.max, value);
      }
      previousTs = p.ts;
    }
    flush();
    return d;
  }

  drawHover(points, x, y, width, height, margin) {
    if (this.hoverX == null || !points.length) {
      this.tooltip.hidden = true;
      return;
    }
    let nearest = points[0];
    for (const p of points) {
      if (Math.abs(x(p.ts) - this.hoverX) < Math.abs(x(nearest.ts) - this.hoverX)) nearest = p;
    }
    const px = x(nearest.ts);
    svgEl("line", { x1: px, x2: px, y1: margin.top, y2: height - margin.bottom, stroke: COLORS.soft }, this.svg);
    svgEl("circle", {
      cx: px, cy: y(nearest[this.field]), r: 5,
      fill: this.color, stroke: COLORS.ground, "stroke-width": 2,
    }, this.svg);
    const time = new Date(nearest.ts).toLocaleTimeString("zh-CN", { hour12: false });
    this.tooltip.textContent = `${time}  ${nearest[this.field]}${this.unit}`;
    this.tooltip.hidden = false;
    const half = this.tooltip.offsetWidth / 2;
    this.tooltip.style.left = `${Math.min(Math.max(px, half), width - half)}px`;
  }
}

const average = (values) => Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);

const trends = [
  new Trend($("spo2Trend"), {
    field: "spo2",
    unit: "%",
    color: COLORS.spo2Trace,
    statsEl: $("spo2Stats"),
    windowEl: $("spo2Window"),
    domain: (values) => {
      const floor = (v) => Math.floor(v / 5) * 5;
      const lows = values.length ? [floor(Math.min(...values))] : [];
      return [Math.min(85, floor(app.settings.spo2.low2), ...lows), 100];
    },
    ticks: (low) => {
      const out = [];
      for (let v = 100; v >= low; v -= 5) out.push(v);
      return out.length > 4 ? out.filter((_, i) => i % 2 === 0) : out;
    },
    limits: () => (app.settings.spo2.enabled
      ? [{ value: app.settings.spo2.low1, level: WARNING }, { value: app.settings.spo2.low2, level: CRITICAL }]
      : []),
    summarize: (v) => `最低 ${Math.min(...v)}%  平均 ${average(v)}%`,
  }),
  new Trend($("prTrend"), {
    field: "hr",
    unit: " 次/分",
    color: COLORS.prTrace,
    statsEl: $("prStats"),
    windowEl: $("prWindow"),
    domain: (values) => {
      if (!values.length) return [40, 100];
      const low = Math.floor((Math.min(...values) - 5) / 10) * 10;
      const high = Math.ceil((Math.max(...values) + 5) / 10) * 10;
      return high - low < 40 ? [low - 10, low + 30] : [low, high];
    },
    ticks: (low, high) => [low, Math.round((low + high) / 2), high],
    limits: () => {
      const { pr } = app.settings;
      if (!pr.enabled) return [];
      return [
        { value: pr.low1, level: WARNING }, { value: pr.high1, level: WARNING },
        { value: pr.low2, level: CRITICAL }, { value: pr.high2, level: CRITICAL },
      ];
    },
    summarize: (v) => `最低 ${Math.min(...v)}  最高 ${Math.max(...v)}  平均 ${average(v)} 次/分`,
  }),
];
const drawTrends = () => trends.forEach((t) => t.draw());

/* ---------- Soft keys ---------- */
$("silence").addEventListener("click", () => {
  const now = Date.now();
  const level = engine.active()[0]?.level ?? 0;
  if (pause.remainingMs(now, level) > 0) pause.resume();
  else pause.pause(now, level, SILENCE_MS);
  render();
});

$("trendWindow").addEventListener("click", () => {
  const next = (TREND_WINDOWS.indexOf(app.trendWindow) + 1) % TREND_WINDOWS.length;
  app.trendWindow = TREND_WINDOWS[next];
  $("trendWindow").textContent = `趋势 ${app.trendWindow.label}`;
  drawTrends();
});

$("download").addEventListener("click", () => {
  const rows = app.records.map((r) =>
    [new Date(r.ts).toLocaleString("sv-SE"), r.spo2 ?? "", r.hr ?? "", r.pi ?? ""].join(","));
  const csv = ["时间,血氧,脉率,灌注原始值", ...rows].join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  const stamp = new Date().toLocaleString("sv-SE").replace(/[-: ]/g, "").slice(0, 12);
  const link = Object.assign(document.createElement("a"), { href: url, download: `hs30a-${stamp}.csv` });
  link.click();
  URL.revokeObjectURL(url);
});

/* ---------- Settings dialog ---------- */
const settingFields = [...document.querySelectorAll("[data-path]")];

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value[key], object);
}
function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((value, key) => value[key], object)[last] = value;
}

function fillForm(settings) {
  for (const field of settingFields) {
    const value = getPath(settings, field.dataset.path);
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
  }
  checkForm();
}

function readForm() {
  const settings = cloneSettings();
  for (const field of settingFields) {
    let value;
    if (field.type === "checkbox") value = field.checked;
    else value = field.value === "" ? NaN : Number(field.value);
    setPath(settings, field.dataset.path, value);
  }
  return settings;
}

function checkForm() {
  const errors = validateSettings(readForm());
  $("settingsError").textContent = errors[0] ?? "";
  $("saveSettings").disabled = errors.length > 0;
}

$("openSettings").addEventListener("click", () => {
  fillForm(app.settings);
  $("settings").showModal();
});
$("settingsForm").addEventListener("input", checkForm);
$("restoreDefaults").addEventListener("click", () => fillForm(cloneSettings()));
$("cancelSettings").addEventListener("click", () => $("settings").close());
$("testWarning").addEventListener("click", () => playPattern(WARNING));
$("testCritical").addEventListener("click", () => playPattern(CRITICAL));
$("settingsForm").addEventListener("submit", () => {
  const settings = readForm();
  if (validateSettings(settings).length) return;
  app.settings = settings;
  engine.setSettings(settings);
  saveStored("hs30a.settings", settings);
  renderLimits();
  drawTrends();
  render();
});

/* ---------- Alarm log dialog ---------- */
function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function renderLog() {
  const names = { spo2: "血氧", pr: "脉率" };
  const units = { spo2: "%", pr: " 次/分" };
  $("logEmpty").hidden = engine.log.length > 0;
  $("logRows").replaceChildren(...engine.log.map((entry) => {
    const row = document.createElement("tr");
    const peak = entry.direction === "low" ? "最低" : "最高";
    const cells = [
      new Date(entry.startedAt).toLocaleString("sv-SE"),
      levelName(entry.peakLevel),
      `${names[entry.param]}${peak} ${entry.worst}${units[entry.param]}`,
      entry.endedAt ? formatDuration(entry.endedAt - entry.startedAt) : "进行中",
    ];
    row.replaceChildren(...cells.map((text) => {
      const cell = document.createElement("td");
      cell.textContent = text;
      return cell;
    }));
    return row;
  }));
}

$("openLog").addEventListener("click", () => {
  renderLog();
  $("log").showModal();
});
$("closeLog").addEventListener("click", () => $("log").close());
$("clearLog").addEventListener("click", () => {
  engine.log.splice(0, engine.log.length, ...engine.log.filter((entry) => entry.endedAt === null));
  saveLog();
  renderLog();
  render();
});

/* ---------- Keep the screen on while monitoring ---------- */
let wakeLock = null;

async function syncWakeLock() {
  const wanted = app.state === "connected" && !document.hidden;
  if (wanted && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (error) {
      console.info("Screen wake lock unavailable", error);
    }
  } else if (!wanted && wakeLock) {
    wakeLock.release();
  }
}
document.addEventListener("visibilitychange", syncWakeLock);

/* ---------- Data source ---------- */
const store = new RecordStore();

function addRecord(record) {
  app.records.push(record);
  if (app.records.length > MAX_RECORDS) app.records.shift();
  $("download").disabled = false;
}

const handlers = {
  onState(state, { detail = null, replay = false } = {}) {
    app.state = state;
    app.detail = detail;
    app.replay = replay;
    wave.lastSeq = null;
    syncWakeLock();
    render();
  },
  onWave: enqueueWave,
  onStatus(record) {
    app.latest = record;
    app.lastStatusAt = performance.now();
    if (record.spo2 != null) app.everMonitored = true;
    addRecord(record);
    if (!bridgeMode) store.add(record);
    render();
    if (app.trendWindow === TREND_WINDOWS[0]) drawTrends();
  },
  onHistory(records) {
    app.records = records;
    $("download").disabled = records.length === 0;
    drawTrends();
  },
};

let transport = null;

function connectOrDisconnect() {
  if (CONNECTION_ACTIVE.has(app.state)) transport.disconnect();
  else transport.pick();
}
$("connectKey").addEventListener("click", connectOrDisconnect);
$("hintConnect").addEventListener("click", connectOrDisconnect);

/* ---------- Start ---------- */
for (const type of ["pointerdown", "keydown"]) {
  addEventListener(type, () => { unlockAudio(); }, { capture: true });
}
new ResizeObserver(resizeWave).observe(canvas);
new ResizeObserver(drawTrends).observe($("spo2Trend"));
resizeWave();
renderLimits();

if (bridgeMode) {
  transport = new BridgeTransport(handlers);
} else {
  const support = bluetoothSupport();
  if (support === "ok") {
    transport = new BleTransport(handlers);
    app.state = "idle";
  } else {
    app.state = support;
  }
  store.load().then((saved) => {
    app.records = [...saved, ...app.records];
    $("download").disabled = app.records.length === 0;
    drawTrends();
  });
}

render();
setInterval(render, 500);
setInterval(drawTrends, 5000);
requestAnimationFrame(tick);
