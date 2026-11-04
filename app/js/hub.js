/**
 * Game hub: FreezeNova Roblox (ours, always first) + the Astra library (listed, greyed out as unfinished).
 * Selection only for now: Astra entries are not clickable and no Astra session is ever started.
 * Everything that touches the network goes through the injected `fetchAstra` (the Singuloxy/libcurl proxy),
 * so the list and the icons are proxied and this file has no browser-only imports.
 */
import { ASTRA_ICONS } from "./astra-icons.js";

export const ASTRA_ORIGIN = "https://astra-education.top";
const CACHE_KEY = "sc_astra_games";
const CACHE_TTL = 60 * 60 * 1000;
const ICON_CONCURRENCY = 4;

/** Accepts {ok, games:[...]} or a bare array. Drops blanks, Astra's own Roblox (ours is FreezeNova), dupes; sorts by name. */
export function normalizeGames(raw, icons = ASTRA_ICONS) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.games) ? raw.games : [];
  const seen = new Set(), out = [];
  for (const g of list) {
    if (!g || typeof g !== "object") continue;
    const id = String(g.gameId ?? g.id ?? "").trim();
    const name = String(g.gameName ?? g.name ?? "").trim();
    if (!id || !name || seen.has(id) || /^(ng_)?roblox$/i.test(id)) continue;
    seen.add(id);
    out.push({ id, name, icon: icons[id] || null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export class Hub {
  /** @param {{ fetchAstra: (url: string, init?: object) => Promise<Response>, doc?: Document }} o */
  constructor({ fetchAstra, doc = typeof document !== "undefined" ? document : null }) {
    this.fetchAstra = fetchAstra;
    this.doc = doc;
    this.icons = new Map();   // path -> blob URL
    this.queue = [];
    this.active = 0;
    this.games = [];
  }

  $(id) { return this.doc.getElementById(id); }

  /** Prepare the Astra section (the FreezeNova card is static markup in index.html). */
  mount() {
    this.grid = this.$("astra-grid");
    this.note = this.$("astra-note");
    this.count = this.$("astra-count");
    this.io = "IntersectionObserver" in globalThis
      ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { this.io.unobserve(e.target); this.loadIcon(e.target); } }), { rootMargin: "200px" })
      : null;
    this.setNote("Loading the Astra library…");
  }

  setNote(text, retry = false) {
    if (!this.note) return;
    this.note.textContent = text;
    this.note.hidden = !text;
    if (retry) {
      const b = this.doc.createElement("button");
      b.type = "button"; b.className = "ld-retry"; b.textContent = "Try again";
      b.addEventListener("click", () => this.loadAstra());
      this.note.append(" ", b);
    }
  }

  readCache() {
    try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); return c && Array.isArray(c.games) ? c : null; } catch { return null; }
  }

  async loadAstra() {
    const cached = this.readCache();
    if (cached && Date.now() - cached.t < CACHE_TTL) return this.render(cached.games);
    this.setNote("Loading the Astra library…");
    try {
      const res = await this.fetchAstra(ASTRA_ORIGIN + "/api/cg/games", { cache: "no-store" });
      const data = await res.json();
      const games = normalizeGames(data);
      if (!games.length) throw new Error("empty catalog");
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), games })); } catch {}
      this.render(games);
    } catch (e) {
      console.warn("[hub] Astra list failed:", e && e.message);
      if (cached) this.render(cached.games);
      else this.setNote("Couldn't load the Astra library.", true);
    }
  }

  render(games) {
    this.games = games;
    this.setNote("");
    if (this.count) this.count.textContent = String(games.length);
    const d = this.doc, frag = d.createDocumentFragment();
    for (const g of games) {
      const card = d.createElement("div");
      card.className = "game-card locked";
      card.setAttribute("aria-disabled", "true");
      const art = d.createElement("div");
      art.className = "card-art";
      art.setAttribute("aria-hidden", "true");
      art.textContent = g.name.charAt(0).toUpperCase();
      if (g.icon) art.dataset.icon = g.icon;
      const h = d.createElement("h3"); h.textContent = g.name;
      const tag = d.createElement("div"); tag.className = "soon-tag"; tag.textContent = "Unfinished";
      card.append(art, h, tag);
      frag.append(card);
    }
    this.grid.replaceChildren(frag);
    for (const art of this.grid.querySelectorAll(".card-art[data-icon]")) this.io ? this.io.observe(art) : this.loadIcon(art);
  }

  /** Icons come through the proxy too (blob URLs), a few at a time, only when scrolled near. */
  loadIcon(art) {
    const path = art.dataset.icon;
    if (this.icons.has(path)) return this.applyIcon(art, this.icons.get(path));
    this.queue.push([art, path]);
    this.pump();
  }

  applyIcon(art, url) {
    art.style.backgroundImage = `url("${url}")`;
    art.classList.add("has-img");
    art.textContent = "";
  }

  pump() {
    while (this.active < ICON_CONCURRENCY && this.queue.length) {
      const [art, path] = this.queue.shift();
      this.active++;
      (async () => {
        try {
          if (!this.icons.has(path)) {
            const res = await this.fetchAstra(ASTRA_ORIGIN + path);
            if (!res.ok) throw new Error(String(res.status));
            this.icons.set(path, URL.createObjectURL(await res.blob()));
          }
          this.applyIcon(art, this.icons.get(path));
        } catch (e) { /* keep the lettered placeholder */ }
      })().finally(() => { this.active--; this.pump(); });
    }
  }
}
