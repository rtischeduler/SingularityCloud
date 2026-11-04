/**
 * SingularityCloud entry point: both cloud-gaming setups merged behind one hub.
 *
 *  - FreezeNova Roblox: the existing flow (click -> Supabase session -> queue -> WebRTC/mediasoup stream).
 *  - Astra library: catalog + icons through the Singuloxy proxy, shown in the hub as unfinished.
 *    Astra sessions/launching are intentionally NOT wired yet.
 *
 * The loader in index.html imports this file and calls start().
 */
import { startSession, STEPS } from "./app/js/session.js";
import { auth, astraFetch } from "./app/js/net.js";
import { Hub } from "./app/js/hub.js";

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
  hub.loadAstra();                         // proxy + catalog load in the background
  return { app, hub };
}
