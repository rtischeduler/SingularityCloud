/** The shared loading screen (#loading-screen in index.html): FreezeNova and Astra both drive it, with a step counter line. */
export class Loader {
  constructor(doc = document) {
    this.el = doc.getElementById("loading-screen");
    this.fill = doc.getElementById("ld-fill");
    this.status = doc.getElementById("ld-status");
    this.count = doc.getElementById("ld-count");
    this.cancelBtn = doc.getElementById("ld-cancel");
    this.onCancel = null;
    this.cancelBtn?.addEventListener("click", () => this.onCancel?.());
  }

  show(text = "Loading", { cancel = null } = {}) {
    clearTimeout(this._t);
    this.el.classList.remove("hidden", "failed");
    this.el.classList.add("active");
    this.fill.style.transform = "scaleX(0)";
    this.status.textContent = text;
    if (this.count) this.count.textContent = "";
    this.onCancel = cancel;
    if (this.cancelBtn) this.cancelBtn.hidden = !cancel;
  }

  /** i of total, 1-based; the line under the bar reads "3 / 7". */
  step(i, total, text) {
    this.fill.style.transform = `scaleX(${Math.min(i / total, 1)})`;
    if (text) this.status.textContent = text;
    if (this.count) this.count.textContent = `${i} / ${total}`;
  }

  text(t) { this.status.textContent = t; }

  hide() {
    this.onCancel = null;
    if (this.cancelBtn) this.cancelBtn.hidden = true;
    this.el.classList.add("hidden");
    this._t = setTimeout(() => this.el.classList.remove("active"), 600);
  }
}
