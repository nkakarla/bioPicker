// BioPicker — Apple push notifications (APNs, token-based auth). Copyright (c) 2026 ePerf
//
// Configure with an APNs auth key from developer.apple.com → Keys:
//   APNS_KEY_FILE=/path/AuthKey_XXXXXXXXXX.p8  APNS_KEY_ID=XXXXXXXXXX  APNS_TEAM_ID=XKQ3C2A6A9  APNS_TOPIC=com.eperf.biopicker
// Without them, notifications are skipped silently.
import crypto from "node:crypto";
import fs from "node:fs";
import http2 from "node:http2";

const HOSTS = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" };
const cfg = () => ({
  keyFile: process.env.APNS_KEY_FILE,
  keyId: process.env.APNS_KEY_ID,
  teamId: process.env.APNS_TEAM_ID,
  topic: process.env.APNS_TOPIC || "com.eperf.biopicker",
});
export const pushConfigured = () => {
  const c = cfg();
  return !!(c.keyFile && c.keyId && c.teamId && fs.existsSync(c.keyFile));
};

// APNs accepts a provider token for up to an hour; refresh every 50 minutes
let jwt = { token: null, at: 0 };
function providerToken() {
  if (jwt.token && Date.now() - jwt.at < 50 * 60 * 1000) return jwt.token;
  const c = cfg();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "ES256", kid: c.keyId });
  const body = b64({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: fs.readFileSync(c.keyFile), dsaEncoding: "ieee-p1363" });
  jwt = { token: `${head}.${body}.${sig.toString("base64url")}`, at: Date.now() };
  return jwt.token;
}

const clients = {};
function client(env) {
  const c = clients[env];
  if (c && !c.closed && !c.destroyed) return c;
  const s = http2.connect(HOSTS[env]);
  s.on("error", () => {});
  s.setTimeout(5 * 60 * 1000, () => s.close());
  s.unref();
  return (clients[env] = s);
}

function sendOne(device, payload) {
  return new Promise((resolve) => {
    const req = client(device.env).request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": cfg().topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0, body = "";
    req.on("response", (h) => (status = h[":status"]));
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve({ status, reason: (() => { try { return JSON.parse(body).reason; } catch { return ""; } })() }));
    req.on("error", (e) => resolve({ status: 0, reason: e.message }));
    req.setTimeout(15000, () => { req.close(); resolve({ status: 0, reason: "timeout" }); });
    req.end(JSON.stringify(payload));
  });
}

/**
 * Sends an alert to every device of a user. Devices Apple reports as gone are passed to onGone.
 * @param {{token:string, env:string}[]} devices
 */
export async function notify(devices, { title, body, data = {} }, onGone = () => {}) {
  if (!pushConfigured() || !devices?.length) return;
  const payload = { aps: { alert: { title, body }, sound: "default" }, ...data };
  for (const d of devices) {
    const r = await sendOne(d, payload);
    if (r.status === 410 || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(r.reason)) onGone(d.token);
    else if (r.status !== 200) console.error(`[push] ${r.status} ${r.reason}`);
  }
}
