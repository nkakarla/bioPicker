// BioPicker — paid plans: Stripe subscriptions on the web, Apple In-App Purchase in the iPhone app.
// Copyright (c) 2026 EPerf
//
// Each plan in billing.json can carry a Stripe price id and an Apple product id. A paid subscription is stored on
// the account as u.sub = { provider, planId, status, periodEnd, cancelAtPeriodEnd, … } and usage.planOf() uses it.
// Nothing here trusts the browser: Stripe changes arrive as signed webhooks (and are re-read from Stripe's API),
// and Apple purchases are signed JWS documents whose certificate chain must lead to Apple's root certificate.
//
// Stripe: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.  Apple: APPLE_BUNDLE_ID (default com.eperf.biopicker).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./util.js";
import * as auth from "./auth.js";
import * as usage from "./usage.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_HOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APPLE_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.eperf.biopicker";
const STRIPE_API = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, ""); // overridable for tests

export const stripeReady = () => !!(STRIPE_KEY && STRIPE_HOOK_SECRET);
const stripePlans = () => usage.getBilling().plans.filter((p) => p.stripePriceId);
const applePlans = () => usage.getBilling().plans.filter((p) => p.appleProductId);
/** Can someone subscribe from inside BioPicker? (the web with Stripe, or the iPhone app with Apple) */
export const canSubscribe = () => (stripeReady() && stripePlans().length > 0) || applePlans().length > 0;
usage.setSubscribeCheck(canSubscribe);

export function status() {
  return {
    stripe: { keys: !!STRIPE_KEY, webhookSecret: !!STRIPE_HOOK_SECRET, ready: stripeReady(), plans: stripePlans().length, live: STRIPE_KEY.startsWith("sk_live_") || STRIPE_KEY.startsWith("rk_live_") },
    apple: { bundleId: APPLE_BUNDLE_ID, plans: applePlans().length },
  };
}

const userBy = (fn) => auth.allUsers().find(fn) || null;
function setSub(u, sub) {
  // an account that signed up when free spots were full stays "waiting" underneath: if the subscription ends it
  // goes back to no plan rather than taking a free spot (the admin can give it one)
  u.sub = { ...sub, updatedAt: new Date().toISOString() };
  auth.updateUser(u);
  console.log(`[pay] ${u.username}: ${sub.provider} ${sub.planId} ${sub.status}${sub.periodEnd ? ` until ${sub.periodEnd}` : ""}`);
}

// ============================================================================
// Stripe (REST API, form-encoded; no SDK needed)
// ============================================================================
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, pathname, body) {
  if (!STRIPE_KEY) throw err(503, "Payments aren't set up on this server yet.");
  const r = await fetch(`${STRIPE_API}/v1/${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? form(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`[pay] Stripe ${method} ${pathname}: ${r.status} ${j.error?.message || ""}`);
    throw err(502, "The payment service didn't accept that. Please try again in a minute.");
  }
  return j;
}

/** A Stripe Checkout page for this plan (new subscribers), or the customer portal to change or cancel (existing ones). */
export async function stripeCheckout(u, planId, origin) {
  if (!stripeReady()) throw err(503, "Payments aren't set up on this server yet.");
  const plan = usage.planById(planId);
  if (!plan?.stripePriceId) throw err(400, "That plan can't be bought here.");
  const sub = usage.activeSub(u);
  if (sub?.provider === "apple") throw err(409, "You subscribe through the App Store. Change your plan in the iPhone app or in your Apple ID's Subscriptions settings.");
  if (sub?.provider === "stripe" && u.sub.customer) return stripePortal(u, origin);
  const s = await stripe("POST", "checkout/sessions", {
    mode: "subscription",
    line_items: { 0: { price: plan.stripePriceId, quantity: 1 } },
    client_reference_id: u.id,
    ...(u.sub?.customer ? { customer: u.sub.customer } : {}),
    metadata: { userId: u.id, planId: plan.id },
    subscription_data: { metadata: { userId: u.id, planId: plan.id } },
    allow_promotion_codes: "true",
    success_url: `${origin}/?paid=1`,
    cancel_url: `${origin}/?paid=0`,
  });
  return s.url;
}
export async function stripePortal(u, origin) {
  if (!u.sub?.customer || u.sub.provider !== "stripe") throw err(400, "There's no web subscription on this account.");
  const s = await stripe("POST", "billing_portal/sessions", { customer: u.sub.customer, return_url: `${origin}/` });
  return s.url;
}

/** Ends a web subscription at once (the account is being deleted). Apple subscriptions can only be cancelled by the person. */
export async function cancelForDeletion(u) {
  if (u.sub?.provider !== "stripe" || !u.sub.subscription || !usage.activeSub(u)) return false;
  await stripe("DELETE", `subscriptions/${encodeURIComponent(u.sub.subscription)}`);
  return true;
}

/** Checks the Stripe-Signature header (HMAC-SHA256 of "timestamp.body", 5-minute tolerance). */
export function verifyStripeSignature(raw, header, secret = STRIPE_HOOK_SECRET, now = Date.now()) {
  if (!secret) return false;
  const parts = {};
  const v1 = [];
  for (const kv of String(header || "").split(",")) {
    const [k, v] = kv.split("=");
    if (k === "t") parts.t = v;
    if (k === "v1" && v) v1.push(v);
  }
  if (!parts.t || !v1.length || Math.abs(now / 1000 - Number(parts.t)) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest();
  return v1.some((sig) => {
    const got = Buffer.from(sig, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

/** Stores the current state of a Stripe subscription (always re-read from Stripe, so event order doesn't matter). */
async function applyStripeSubscription(subId, hint = {}) {
  const s = await stripe("GET", `subscriptions/${encodeURIComponent(subId)}`);
  const item = s.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = usage.getBilling().plans.find((p) => p.stripePriceId === priceId);
  const u = (s.metadata?.userId && auth.getUser(s.metadata.userId)) || (hint.userId && auth.getUser(hint.userId)) || userBy((x) => x.sub?.provider === "stripe" && x.sub.customer === s.customer);
  if (!u) return console.warn(`[pay] Stripe subscription ${subId}: no matching account`);
  if (!plan) console.warn(`[pay] Stripe price ${priceId} isn't on any plan; set it on Plans & paywall`);
  // an Apple subscription that is still running stays the one that counts
  if (usage.activeSub(u)?.provider === "apple") return console.warn(`[pay] ${u.username} has an Apple subscription too; keeping it`);
  const end = item?.current_period_end || s.current_period_end;
  setSub(u, {
    provider: "stripe",
    planId: plan?.id || u.sub?.planId || "",
    status: s.status === "canceled" || s.status === "incomplete_expired" ? "canceled" : s.status, // active, trialing, past_due, unpaid, incomplete
    periodEnd: end ? new Date(end * 1000).toISOString() : null,
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    customer: s.customer,
    subscription: s.id,
    live: !!s.livemode,
  });
}

/** Handles a verified Stripe webhook event. */
export async function stripeEvent(ev) {
  const o = ev.data?.object || {};
  if (ev.type === "checkout.session.completed" && o.mode === "subscription" && o.subscription) {
    await applyStripeSubscription(o.subscription, { userId: o.client_reference_id });
  } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(ev.type)) {
    await applyStripeSubscription(o.id);
  } else if (/^invoice\.(paid|payment_failed)$/.test(ev.type) && (o.subscription || o.parent?.subscription_details?.subscription)) {
    await applyStripeSubscription(o.subscription || o.parent.subscription_details.subscription);
  }
}

// ============================================================================
// Apple In-App Purchase (StoreKit 2 signed transactions, App Store Server Notifications V2)
// ============================================================================
let APPLE_ROOT = new crypto.X509Certificate(fs.readFileSync(path.join(ROOT, "lib", "certs", "AppleRootCA-G3.cer")));
// SHA-256 fingerprint published by Apple for "Apple Root CA - G3"
const APPLE_ROOT_FP = "63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79";
if (APPLE_ROOT.fingerprint256 !== APPLE_ROOT_FP) throw new Error("lib/certs/AppleRootCA-G3.cer is not Apple's root certificate");
/** Tests only (NODE_ENV=test): trust a test root instead of Apple's. */
export function useTestAppleRoot(pem) {
  if (process.env.NODE_ENV !== "test") throw new Error("useTestAppleRoot is for tests only");
  APPLE_ROOT = new crypto.X509Certificate(pem);
}

/** DER bytes of an object identifier, to check Apple's marker extensions on the signing certificates. */
function oidBytes(oid) {
  const [a, b, ...rest] = oid.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return Buffer.from([0x06, out.length, ...out]);
}
const LEAF_OID = oidBytes("1.2.840.113635.100.6.11.1"); // App Store receipt signing
const INTERMEDIATE_OID = oidBytes("1.2.840.113635.100.6.2.1"); // Apple Worldwide Developer Relations CA

/**
 * Verifies an App Store JWS (ES256, x5c chain leaf → intermediate → Apple root) and returns its payload.
 * `root` is replaceable only so tests can use their own chain.
 */
export function verifyAppleJWS(jws, { root = APPLE_ROOT, checkOids = true } = {}) {
  root = root || APPLE_ROOT;
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw err(400, "That isn't a signed App Store document.");
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url"));
  } catch {
    throw err(400, "That isn't a signed App Store document.");
  }
  if (header.alg !== "ES256" || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw err(400, "Unexpected App Store signature.");
  const [leaf, mid, top] = header.x5c.map((c) => new crypto.X509Certificate(Buffer.from(c, "base64")));
  const bad = (why) => {
    console.warn(`[pay] rejected App Store document: ${why}`);
    return err(400, "The App Store signature didn't check out.");
  };
  if (!top.raw.equals(root.raw)) throw bad("chain doesn't end at Apple's root");
  if (!mid.checkIssued(root) || !mid.verify(root.publicKey)) throw bad("intermediate not issued by the root");
  if (!leaf.checkIssued(mid) || !leaf.verify(mid.publicKey)) throw bad("leaf not issued by the intermediate");
  if (!mid.ca) throw bad("intermediate is not a CA");
  if (checkOids && (!leaf.raw.includes(LEAF_OID) || !mid.raw.includes(INTERMEDIATE_OID))) throw bad("missing Apple certificate markers");
  // certificates must have been valid when Apple signed the document
  const at = payload.signedDate || payload.signedDate === 0 ? Number(payload.signedDate) : Date.now();
  for (const c of [leaf, mid]) if (at < Date.parse(c.validFrom) || at > Date.parse(c.validTo)) throw bad("certificate not valid at the signing date");
  const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  if (!ok) throw bad("signature mismatch");
  return payload;
}

/** The per-account token the app attaches to purchases, so Apple's notifications can be matched to the account. */
export function appleAccountToken(u) {
  if (!u.appleToken) {
    u.appleToken = crypto.randomUUID();
    auth.updateUser(u);
  }
  return u.appleToken;
}

/** Applies a verified StoreKit transaction. `u` is the signed-in account (purchase or restore), or null (notification). */
function applyAppleTransaction(t, u, renewal = null) {
  if (t.bundleId !== APPLE_BUNDLE_ID) throw err(400, "That purchase is for a different app.");
  const plan = usage.getBilling().plans.find((p) => p.appleProductId === t.productId);
  if (!plan) {
    console.warn(`[pay] Apple product ${t.productId} isn't on any plan; set it on Plans & paywall`);
    if (u) throw err(400, "That purchase isn't for a BioPicker plan.");
    return null;
  }
  const original = String(t.originalTransactionId || t.transactionId || "");
  const token = String(t.appAccountToken || "").toLowerCase();
  const byToken = token ? userBy((x) => x.appleToken?.toLowerCase() === token) : null;
  const byOriginal = userBy((x) => x.sub?.provider === "apple" && x.sub.original === original);
  if (u) {
    // a purchase belongs to the account it was made for; a restore can't move it to another account
    if ((byToken && byToken.id !== u.id) || (byOriginal && byOriginal.id !== u.id)) throw err(409, "This App Store subscription belongs to another BioPicker account.");
  } else u = byToken || byOriginal;
  if (!u) return console.warn(`[pay] Apple transaction ${original}: no matching account`), null;
  const expires = t.expiresDate ? new Date(Number(t.expiresDate)).toISOString() : null;
  // keep the newest state: ignore an older renewal (earlier purchase date) arriving after a newer one
  const bought = Number(t.purchaseDate) || null;
  if (u.sub?.provider === "apple" && u.sub.original === original && u.sub.purchaseDate && bought && bought < u.sub.purchaseDate && !t.revocationDate) return u;
  const stillRunning = expires && Date.parse(expires) > Date.now();
  if (usage.activeSub(u)?.provider === "stripe" && stillRunning) console.warn(`[pay] ${u.username} now has an Apple subscription as well as a web one`);
  setSub(u, {
    provider: "apple",
    planId: plan.id,
    status: t.revocationDate ? "revoked" : stillRunning ? "active" : "expired",
    periodEnd: expires,
    cancelAtPeriodEnd: renewal ? renewal.autoRenewStatus === 0 : u.sub?.provider === "apple" ? !!u.sub.cancelAtPeriodEnd : false,
    original,
    purchaseDate: bought,
    productId: t.productId,
    environment: t.environment || "",
  });
  return u;
}

/** The app sends the signed transaction after a purchase or restore. */
export function applePurchase(u, jws) {
  const t = verifyAppleJWS(jws);
  if (t.type && t.type !== "Auto-Renewable Subscription") throw err(400, "That purchase isn't a subscription.");
  applyAppleTransaction(t, u);
  return usage.planOf(u);
}

/** App Store Server Notifications V2: renewals, expiries, refunds, cancellations. */
export function appleNotification(signedPayload) {
  const n = verifyAppleJWS(signedPayload);
  const d = n.data || {};
  if (d.bundleId && d.bundleId !== APPLE_BUNDLE_ID) throw err(400, "Notification for a different app.");
  if (!d.signedTransactionInfo) return { type: n.notificationType, applied: false };
  const t = verifyAppleJWS(d.signedTransactionInfo);
  const renewal = d.signedRenewalInfo ? verifyAppleJWS(d.signedRenewalInfo) : null;
  const u = applyAppleTransaction(t, null, renewal);
  console.log(`[pay] Apple notification ${n.notificationType}${n.subtype ? `/${n.subtype}` : ""} (${d.environment || "?"})${u ? ` for ${u.username}` : ""}`);
  return { type: n.notificationType, applied: !!u };
}

/** What the plans page needs: the plans someone can choose, how, and their current subscription. */
export function plansFor(u) {
  const b = usage.getBilling();
  const sub = u.sub || null;
  return {
    current: { planId: usage.planOf(u).id, source: usage.planSource(u) },
    sub: sub && { provider: sub.provider, planId: sub.planId, status: sub.status, periodEnd: sub.periodEnd, cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd, active: !!usage.activeSub(u) },
    stripe: stripeReady(),
    plans: b.plans
      .filter((p) => p.stripePriceId || p.appleProductId || p.id === b.defaultPlan)
      .map((p) => ({ id: p.id, name: p.name, priceMonthly: p.priceMonthly, description: p.description, rendersPerMonth: p.rendersPerMonth, series: p.series, aiBudget: p.aiBudgetMonthly != null, web: !!(p.stripePriceId && stripeReady()), appleProductId: p.appleProductId || null, free: p.id === b.defaultPlan })),
  };
}
