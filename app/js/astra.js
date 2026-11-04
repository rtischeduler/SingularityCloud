/**
 * Astra sessions: a small direct client for Astra's cloud-gaming API (launch -> status -> WebRTC answer -> input).
 * Every request goes through the injected `fetchAstra` (the Singuloxy proxy); WebRTC media itself is peer-to-peer/TURN.
 * Supported: games whose launch returns a WebRTC offer (offerSdp). Other stream types report "not supported yet".
 * No DOM access at import time, so the pure helpers are unit-testable (scripts/astra.test.mjs).
 */
export const ASTRA_ORIGIN = "https://astra-education.top";

/* ------------------------------ pure helpers ------------------------------ */

export async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Proof-of-work for /api/cg/quiz: find n in [0, maxnumber] with sha256(salt + n) === challenge. Returns n or null. */
export async function solveQuiz(q, digest = sha256hex, chunk = 2000) {
  if (q.algorithm && !/^sha-?256$/i.test(q.algorithm)) throw new Error("unsupported quiz algorithm");
  for (let start = 0; start <= q.maxnumber; start += chunk) {
    const end = Math.min(q.maxnumber, start + chunk - 1);
    const jobs = [];
    for (let n = start; n <= end; n++) jobs.push(digest(q.salt + n));
    const i = (await Promise.all(jobs)).indexOf(q.challenge);
    if (i >= 0) return start + i;
  }
  return null;
}

export function quizPayload(q, number) {
  return btoa(JSON.stringify({ algorithm: q.algorithm, challenge: q.challenge, number, salt: q.salt, signature: q.signature }));
}

/** "a=1; Path=/, b=2; Expires=Wed, 01 Jan 2031 00:00:00 GMT" -> { a: "1", b: "2" } (name=value pairs only). */
export function parseSetCookie(header) {
  const out = {};
  if (!header) return out;
  const parts = Array.isArray(header) ? header : String(header).split(/,(?=\s*[^;,=\s]+=)/);
  for (const p of parts) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(p);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Control-channel wire format (matches Astra's own client). */
export const WIRE = { MOUSE: 41, MOVE: 0, L_DOWN: 1, L_UP: 2, M_DOWN: 3, M_UP: 4, R_DOWN: 5, R_UP: 6, WHEEL: 11, KEY_DOWN: 101, KEY_UP: 102, TEXT: 103, RANGE: 32767 };
export function frame(type, ints) {
  const buf = new ArrayBuffer(4 + 4 * ints.length), v = new Int32Array(buf);
  v[0] = type;
  ints.forEach((n, i) => { v[i + 1] = n; });
  return buf;
}
export function keyFrame(kind, keyCode, mods = 0) {
  const buf = new ArrayBuffer(4), a = new Uint8Array(buf);
  a[0] = kind; a[1] = 1; a[2] = keyCode; a[3] = mods;
  return buf;
}
export function textFrame(ch) {
  const buf = new ArrayBuffer(6), a = new Uint8Array(buf), u = new Uint8Array(new Uint16Array([ch.codePointAt(0) ?? 0]).buffer);
  a[0] = WIRE.TEXT; a[4] = u[0]; a[5] = u[1];
  return buf;
}

export const hasTurn = (servers) => Array.isArray(servers) && servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => /^turns?:/i.test(String(u))));
const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

/** Same relay choice as Astra's client: edge relay, else their TURN relay, else a plain connection. */
export function rtcConfig(l) {
  if (l.relayVia === "edge" && hasTurn(l.edgeServers)) return { iceServers: l.edgeServers, iceTransportPolicy: "relay" };
  if (hasTurn(l.iceServers) && (l.preferRelay ?? true)) return { iceServers: l.iceServers, iceTransportPolicy: "relay" };
  if (l.iceServers && l.iceServers.length) return { iceServers: l.iceServers };
  return { iceServers: hasTurn(l.edgeServers) ? [...STUN, ...l.edgeServers] : STUN };
}

/* --------------------------------- client --------------------------------- */

export class AstraClient {
  /** @param {(url: string, init?: object) => Promise<Response>} fetchAstra */
  constructor(fetchAstra) {
    this.fetchAstra = fetchAstra;
    this.cookies = {};
  }

  async req(path, init = {}) {
    const headers = { ...(init.headers || {}) };
    const jar = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar) headers.Cookie = jar;
    const res = await this.fetchAstra(ASTRA_ORIGIN + path, { cache: "no-store", ...init, headers });
    try { Object.assign(this.cookies, parseSetCookie(res.headers.get("set-cookie"))); } catch {}
    return res;
  }

  async json(path, init) {
    const res = await this.req(path, init);
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  post(path, body) {
    return this.json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  /** Fetch + solve the launch challenge. Resolves to the payload string, or null when none is required. */
  async quiz() {
    const { res, data } = await this.json("/api/cg/quiz");
    if (!res.ok || !data?.ok) throw new Error("Launch check unavailable.");
    if (!data.quiz) return null;
    const n = await solveQuiz(data.quiz);
    if (n === null) throw new Error("Launch check failed.");
    return quizPayload(data.quiz, n);
  }

  async launch(gameId) {
    let tz; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
    const attempt = async () => this.post("/api/cg/launch", { gameId, ...(tz ? { tz } : {}), ...((q) => (q ? { quiz: q } : {}))(await this.quiz().catch(() => null)) });
    let { res, data } = await attempt();
    if (res.status === 403 && data?.code === "QUIZ_FAILED") ({ res, data } = await attempt());
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Launch failed");
    return data;
  }

  /** Wait until the launch carries an offer (some launches are queued first). */
  async ready(launch, onStatus = () => {}, signal) {
    let l = launch;
    const id = l.sessionId;
    for (let i = 0; i < 100 && !l.offerSdp; i++) {
      if (signal?.aborted) throw new Error("cancelled");
      await new Promise((r) => setTimeout(r, 1500));
      const { res, data } = await this.json(`/api/cg/status?sessionId=${encodeURIComponent(id)}`);
      if (res.ok && data?.ok) { l = { ...l, ...data }; onStatus(String(data.status || "starting")); }
      else if (data && data.error) throw new Error(data.error);
    }
    if (!l.offerSdp) throw new Error(l.status && l.status !== "pending" ? "This game uses a stream type we don't support yet." : "Timed out waiting for the game to start.");
    return l;
  }

  stop(sessionId) {
    return this.post("/api/cg/stop", { sessionId }).catch(() => {});
  }
}

/* --------------------------------- player --------------------------------- */

export class AstraPlayer {
  constructor({ client, launch, video, onStatus = () => {}, onEnded = () => {}, onError = () => {} }) {
    Object.assign(this, { client, launch, video, onStatus, onEnded, onError });
    this.sessionId = launch.sessionId;
    this.pc = null; this.control = null; this.typing = false; this.disposed = false;
    this.timers = []; this.undo = [];
  }

  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.undo.push(() => target.removeEventListener(type, fn, opts)); }
  get ready() { return this.control?.readyState === "open"; }
  send(data) { if (!this.ready) return false; try { this.control.send(data); return true; } catch { return false; } }

  async start() {
    const l = this.launch;
    if (!l.offerSdp) throw new Error("This game uses a stream type we don't support yet.");
    const pc = (this.pc = new RTCPeerConnection(rtcConfig(l)));
    const media = new MediaStream();
    pc.addEventListener("track", (e) => { if (e.track) media.addTrack(e.track); if (this.video.srcObject !== media) this.video.srcObject = media; });
    pc.addEventListener("datachannel", (e) => {
      const ch = e.channel;
      if (ch.label === "fileUpload" || ch.label === "fileDownload") return;
      this.control = ch;
      ch.onmessage = (m) => typeof m.data === "string" && this.onControl(m.data);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (!this.disposed && pc.connectionState === "failed") this.onError(new Error(this.sawFrames ? "The stream connection dropped." : "That session expired before the stream opened. Launch again."));
    });

    this.onStatus("Negotiating stream…");
    await pc.setRemoteDescription({ type: "offer", sdp: l.offerSdp });
    for (const c of l.iceCandidates || []) { try { await pc.addIceCandidate(c); } catch {} }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.gathered(4000);
    this.onStatus("Starting playback…");
    const { res, data } = await this.client.post("/api/cg/ng/answer", { sessionId: this.sessionId, answerSdp: pc.localDescription?.sdp || answer.sdp });
    if (!res.ok || !data?.ok) throw new Error(data?.error || "Could not complete the handshake.");

    this.watchFirstFrame();
    this.heartbeat();
    this.attachInput();
  }

  gathered(ms) {
    const pc = this.pc;
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((done) => {
      const fin = () => { pc.removeEventListener("icegatheringstatechange", chk); clearTimeout(t); done(); };
      const chk = () => pc.iceGatheringState === "complete" && fin();
      pc.addEventListener("icegatheringstatechange", chk);
      const t = setTimeout(fin, ms);
    });
  }

  watchFirstFrame() {
    const v = this.video;
    const seen = () => {
      this.sawFrames = true;
      this.timers.push(setTimeout(() => !this.disposed && this.client.post("/api/cg/ng/report", { sessionId: this.sessionId, alive: true }).catch(() => {}), 25000));
    };
    if (typeof v.requestVideoFrameCallback === "function") v.requestVideoFrameCallback(seen);
    else this.on(v, "playing", seen, { once: true });
  }

  heartbeat() {
    this.timers.push(setInterval(async () => {
      if (this.disposed) return;
      try {
        const { data } = await this.client.post("/api/cg/school/report", { sessionId: this.sessionId });
        if (!this.disposed && data?.stop) this.onEnded("ended by host");
      } catch {}
    }, 12000));
  }

  onControl(text) {
    const f = {};
    for (const part of text.split(":::")) { const i = part.indexOf("="); if (i > 0) f[part.slice(0, i)] = part.slice(i + 1); }
    if (f.msgType === "keyboardStatus") this.typing = String(f.enabled) === "true";
    else if (f.msgType === "sessionComplete") {
      this.client.post("/api/cg/ng/report", { sessionId: this.sessionId, reason: f.reason || "Unknown" }).catch(() => {});
      this.onEnded(f.reason || "Unknown");
    }
  }

  /** Pointer position -> 0..32767 within the video picture (letterbox-aware). */
  coords(e) {
    const v = this.video, r = v.getBoundingClientRect();
    const w = v.videoWidth || r.width, h = v.videoHeight || r.height;
    const s = Math.min(r.width / w, r.height / h), ox = (r.width - w * s) / 2, oy = (r.height - h * s) / 2;
    const x = (e.clientX - r.left - ox) / s, y = (e.clientY - r.top - oy) / s;
    const clamp = (n, m) => Math.max(0, Math.min(m, n));
    return { x: Math.round(clamp(x, w) / w * WIRE.RANGE), y: Math.round(clamp(y, h) / h * WIRE.RANGE), inside: x >= 0 && y >= 0 && x <= w && y <= h };
  }

  mouse(kind, c, wheel = 0) { this.send(frame(WIRE.MOUSE, [kind, c.x, c.y, wheel])); }

  attachInput() {
    const el = this.video, DOWN = [WIRE.L_DOWN, WIRE.M_DOWN, WIRE.R_DOWN], UP = [WIRE.L_UP, WIRE.M_UP, WIRE.R_UP];
    const prevTouch = el.style.touchAction; el.style.touchAction = "none";
    this.undo.push(() => { el.style.touchAction = prevTouch; });
    this.on(el, "contextmenu", (e) => e.preventDefault());
    this.on(el, "pointerdown", (e) => {
      if (!this.ready) return;
      const c = this.coords(e); if (!c.inside) return;
      e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch {}
      this.mouse(WIRE.MOVE, c); this.mouse(DOWN[e.button] ?? WIRE.L_DOWN, c);
    });
    this.on(el, "pointerup", (e) => {
      if (!this.ready) return;
      e.preventDefault(); this.mouse(UP[e.button] ?? WIRE.L_UP, this.coords(e));
      try { el.releasePointerCapture(e.pointerId); } catch {}
    });
    let pending = null;
    this.on(el, "pointermove", (e) => {
      if (!this.ready) return;
      const c = this.coords(e); if (!c.inside) return;
      const queued = pending; pending = c;
      if (!queued) requestAnimationFrame(() => { const p = pending; pending = null; if (p && this.ready) this.mouse(WIRE.MOVE, p); });
    });
    let acc = 0;
    this.on(el, "wheel", (e) => {
      if (!this.ready) return;
      const c = this.coords(e); if (!c.inside) return;
      e.preventDefault();
      acc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      let n = Math.max(-3, Math.min(3, Math.trunc(acc / 100)));
      if (!n) return;
      acc -= n * 100;
      for (let i = 0; i < Math.abs(n); i++) this.mouse(WIRE.WHEEL, c, n > 0 ? -1 : 1);
    }, { passive: false });
    const key = (down) => (e) => {
      if (!this.ready || e.metaKey || (e.ctrlKey && !this.typing)) return;
      if (!e.key || e.key === "Unidentified" || e.isComposing || (e.which ?? e.keyCode) === 229) return;
      e.preventDefault();
      if (e.key.length > 1 || !this.typing) this.send(keyFrame(down ? WIRE.KEY_DOWN : WIRE.KEY_UP, e.which ?? e.keyCode, (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0)));
      else if (down) this.send(textFrame(e.key));
    };
    this.on(window, "keydown", key(true));
    this.on(window, "keyup", key(false));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.undo.forEach((f) => { try { f(); } catch {} });
    try { this.pc?.close(); } catch {}
    this.video.srcObject = null;
  }
}

/* ------------------------------ page controller ------------------------------ */

/** Hub card click -> launch -> stream screen. `show(id)` switches screens; leaving returns to the hub. */
export class AstraSessions {
  constructor({ fetchAstra, show, doc = document, notify = console.warn }) {
    this.client = new AstraClient(fetchAstra);
    Object.assign(this, { show, doc, notify });
    this.video = doc.getElementById("astra-video");
    this.status = doc.getElementById("astra-status");
    this.overlay = doc.getElementById("astra-overlay");
    doc.getElementById("astra-leave")?.addEventListener("click", () => this.leave());
    doc.getElementById("astra-fullscreen")?.addEventListener("click", () => {
      if (doc.fullscreenElement) doc.exitFullscreen(); else doc.documentElement.requestFullscreen?.().catch(() => {});
    });
    doc.defaultView?.addEventListener("beforeunload", () => this.sessionId && navigator.sendBeacon?.(ASTRA_ORIGIN + "/api/cg/stop", new Blob([JSON.stringify({ sessionId: this.sessionId })], { type: "application/json" })));
  }

  say(t) { if (this.status) this.status.textContent = t; }

  async play(game) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.overlay.classList.remove("hidden");
    this.say("Launching " + game.name);
    this.show("screen-astra");
    try {
      let launch = await this.client.launch(game.id);
      this.sessionId = launch.sessionId;
      launch = await this.client.ready(launch, (s) => this.say(s.charAt(0).toUpperCase() + s.slice(1) + "…"), this.abort.signal);
      this.player = new AstraPlayer({
        client: this.client, launch, video: this.video,
        onStatus: (t) => this.say(t),
        onEnded: (why) => { this.notify("Session ended: " + why); this.leave(); },
        onError: (e) => { this.notify(e.message); this.leave(); },
      });
      await this.player.start();
      this.video.play?.().catch(() => {});
      await new Promise((ok) => { const done = () => ok(); this.video.addEventListener("playing", done, { once: true }); setTimeout(done, 15000); });
      this.overlay.classList.add("hidden");
    } catch (e) {
      if (e.message !== "cancelled") { console.error("[astra]", e); this.notify(e.message || "Couldn't start that game."); }
      await this.leave();
    } finally {
      this.busy = false;
    }
  }

  async leave() {
    this.abort?.abort();
    this.player?.dispose(); this.player = null;
    const id = this.sessionId; this.sessionId = null;
    this.show("screen-select");
    if (id) await this.client.stop(id);
  }
}
