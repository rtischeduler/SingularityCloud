// Unit tests for the Astra client's pure helpers (run: node scripts/astra.test.mjs). No network, no DOM.
import assert from "node:assert/strict";
import { solveQuiz, sha256hex, quizPayload, parseSetCookie, frame, keyFrame, textFrame, rtcConfig, hasTurn } from "../app/js/astra.js";

const salt = "abc?x=1", target = 1234;
const q = { algorithm: "SHA-256", salt, challenge: await sha256hex(salt + target), maxnumber: 5000, signature: "sig" };
assert.equal(await solveQuiz(q), target);
assert.equal(await solveQuiz({ ...q, challenge: "0".repeat(64), maxnumber: 50 }), null);
await assert.rejects(() => solveQuiz({ ...q, algorithm: "MD5" }));
assert.deepEqual(JSON.parse(atob(quizPayload(q, 7))), { algorithm: "SHA-256", challenge: q.challenge, number: 7, salt, signature: "sig" });

assert.deepEqual(parseSetCookie("a=1; Path=/; HttpOnly, b=2; Expires=Wed, 01 Jan 2031 00:00:00 GMT"), { a: "1", b: "2" });
assert.deepEqual(parseSetCookie(null), {});

const f = new Int32Array(frame(41, [1, 100, 200, 0]));
assert.deepEqual([...f], [41, 1, 100, 200, 0]);
assert.deepEqual([...new Uint8Array(keyFrame(101, 65, 1))], [101, 1, 65, 1]);
assert.deepEqual([...new Uint8Array(textFrame("A"))], [103, 0, 0, 0, 65, 0]);

const turn = [{ urls: ["turns:t.example:443"] }];
assert.equal(hasTurn(turn), true);
assert.equal(rtcConfig({ iceServers: turn }).iceTransportPolicy, "relay");
assert.equal(rtcConfig({ iceServers: turn, preferRelay: false }).iceTransportPolicy, undefined);
assert.equal(rtcConfig({ relayVia: "edge", edgeServers: turn, iceServers: [] }).iceServers, turn);
assert.ok(rtcConfig({}).iceServers.length);
console.log("astra tests passed");
