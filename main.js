/**
 * SingularityCloud entry point: both cloud-gaming setups merged behind one hub.
 *
 *  - FreezeNova Roblox: the existing flow (Supabase session -> App -> queue -> WebRTC/mediasoup stream).
 *  - Astra library: catalog + icons through the Singuloxy proxy, shown in the hub as unfinished.
 *    Astra sessions/launching are intentionally NOT wired yet.
 *
 * The loader in index.html imports this file and calls start().
 */
import { startSession } from "./app/js/session.js";
import { auth, astraFetch } from "./app/js/net.js";
import { Hub } from "./app/js/hub.js";

/** @param {(step: number) => void} onStep @param {() => void} [onApp] called once the session is ready and the app is loading */
export async function start(onStep = () => {}, onApp = () => {}) {
  const appP = import("./app/js/app.js"); // downloads while the session is created

  const hub = new Hub({ fetchAstra: astraFetch });
  hub.mount();

  auth.token = await startSession(onStep);

  onApp();
  const { App } = await appP;
  const app = new App();      // hub's FreezeNova card (#play-roblox) is static markup, so App can bind it directly
  hub.loadAstra();            // proxy + catalog load after the FreezeNova path is ready; never blocks it
  return { app, hub };
}
