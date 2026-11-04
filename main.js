/**
 * SingularityCloud entry point: both cloud-gaming setups merged behind one hub.
 *
 *  - FreezeNova Roblox: the existing flow (click -> Supabase session -> queue -> WebRTC/mediasoup stream).
 *  - Astra library: catalog, icons and sessions through the Singuloxy proxy.
 *    Clicking an Astra card launches it (app/js/astra.js): quiz -> launch -> status -> WebRTC answer -> input.
 *
 * The loader in index.html imports this file and calls start().
 */
import { startSession, STEPS } from "./app/js/session.js";
import { auth, astraFetch } from "./app/js/net.js";
import { Hub } from "./app/js/hub.js";
import { AstraSessions } from "./app/js/astra.js";

/** FreezeNova session: created when the player clicks Roblox, fresh each time (tokens expire). */
async function ensureSession(onText = () => {}) {
  auth.token = await startSession((i) => onText(STEPS[i] || "Starting"));
}

export async function start() {
  const appP = import("./app/js/app.js");
  const hub = new Hub({ fetchAstra: astraFetch });
  hub.mount();

  const { App } = await appP;
  const app = new App({ ensureSession }); // hub's FreezeNova card (#play-roblox) is static markup, so App binds it directly
  const astra = new AstraSessions({ fetchAstra: astraFetch, show: (id) => app.showScreen(id), notify: (t) => app.notify(t) });
  hub.onSelect = (game) => astra.play(game); // Astra games launch through the proxy; FreezeNova keeps its own flow
  hub.loadAstra();                         // proxy + catalog load in the background
  return { app, hub, astra };
}
