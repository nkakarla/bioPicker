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

// ---------- admin: end a web subscription now and refund the unused part ----------
const clamp01 = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));
const FEE_GUESS = (cents) => Math.round(cents * 0.029 + 30); // Stripe's US card fee, when Stripe doesn't say

/**
 * What a fair refund would be for this month's payment. "Used" is the largest of: the share of the month gone,
 * the share of the film allowance made, and the share of the AI allowance spent, so someone who makes all their
 * films in two days and cancels doesn't get the month back. Stripe keeps its fee when a payment is refunded, so
 * the suggestion takes it off (an EU/UK 14-day cancellation gets the version without the fee).
 */
export async function refundQuote(u, now = Date.now()) {
  if (u.sub?.provider !== "stripe" || !u.sub.subscription || !usage.activeSub(u)) throw err(400, "This account has no running web (Stripe) subscription.");
  const s = await stripe("GET", `subscriptions/${encodeURIComponent(u.sub.subscription)}`);
  const item = s.items?.data?.[0];
  const start = (item?.current_period_start || s.current_period_start || 0) * 1000;
  const end = (item?.current_period_end || s.current_period_end || 0) * 1000;
  if (!start || !end || end <= start) throw err(502, "Stripe didn't give this subscription's current period.");
  // the payment for this period: the newest successful charge to this customer, made since the period began (a day's slack)
  const list = await stripe("GET", `charges?customer=${encodeURIComponent(s.customer)}&limit=10&expand[]=data.balance_transaction`);
  const charge = (list.data || []).find((c) => c.status === "succeeded" && c.paid && c.created * 1000 >= start - 864e5) || null;
  const events = usage.allEvents().filter((e) => e.userId === u.id && Date.parse(e.at) >= start);
  const t = usage.totals(events);
  const lim = usage.limitsOf(u);
  const shares = {
    days: clamp01((now - start) / (end - start)),
    films: lim.rendersPerMonth ? clamp01(t.renders / lim.rendersPerMonth) : 0,
    ai: lim.aiBudgetMonthly ? clamp01(t.aiCost / lim.aiBudgetMonthly) : 0,
  };
  const used = Math.max(shares.days, shares.films, shares.ai);
  const paid = charge?.amount || 0;
  const refundable = charge ? charge.amount - (charge.amount_refunded || 0) : 0;
  const fee = charge ? (typeof charge.balance_transaction?.fee === "number" ? charge.balance_transaction.fee : FEE_GUESS(paid)) : 0;
  const unused = Math.round(paid * (1 - used));
  return {
    currency: charge?.currency || "usd",
    chargeId: charge?.id || null,
    paidAt: charge ? new Date(charge.created * 1000).toISOString() : null,
    paidCents: paid,
    refundableCents: refundable,
    feeCents: fee,
    feeKnown: typeof charge?.balance_transaction?.fee === "number",
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    renders: t.renders,
    renderLimit: lim.rendersPerMonth,
    aiCost: t.aiCost,
    aiBudget: lim.aiBudgetMonthly,
    shares,
    usedShare: used,
    suggestedCents: Math.min(refundable, Math.max(0, unused - fee)),
    suggestedNoFeeCents: Math.min(refundable, Math.max(0, unused)),
  };
}

/** Ends the plan now (cancels the Stripe subscription), then refunds `amountCents` of this period's payment to the card. */
export async function refundAndEnd(u, { amountCents }) {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw err(400, "Enter the refund as an amount of $0 or more.");
  const q = await refundQuote(u);
  if (amountCents > q.refundableCents) throw err(400, `That's more than is left of this month's payment ($${(q.refundableCents / 100).toFixed(2)}).`);
  if (amountCents > 0 && !q.chargeId) throw err(400, "There's no payment for this month to refund. End the plan with a refund of $0.");
  const subId = u.sub.subscription;
  await stripe("DELETE", `subscriptions/${encodeURIComponent(subId)}`);
  // stored as ended before the refund, so the refund's own webhook doesn't try to cancel it again
  await applyStripeSubscription(subId);
  let refund = null;
  if (amountCents > 0) {
    try {
      refund = await stripe("POST", "refunds", { charge: q.chargeId, amount: amountCents, reason: "requested_by_customer", metadata: { userId: u.id, by: "biopicker-admin" } });
    } catch {
      throw err(502, "The plan has ended, but Stripe didn't take the refund. Refund the payment in the Stripe dashboard.");
    }
  }
  u.sub = { ...u.sub, refund: { amountCents, currency: q.currency, at: new Date().toISOString(), id: refund?.id || null } };
  auth.updateUser(u);
  console.log(`[pay] ${u.username}: plan ended by the admin, refunded ${(amountCents / 100).toFixed(2)} ${q.currency}`);
  return { ended: true, refundedCents: amountCents, refundId: refund?.id || null };
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
  } else if (ev.type === "charge.refunded" && o.customer) {
    // a refund made in the Stripe dashboard ends the plan at once, not at the end of the month
    const u = userBy((x) => x.sub?.provider === "stripe" && x.sub.customer === o.customer);
    if (u && usage.activeSub(u) && u.sub.subscription) {
      console.log(`[pay] ${u.username}'s payment was refunded in Stripe: ending the plan now`);
      const s = await stripe("GET", `subscriptions/${encodeURIComponent(u.sub.subscription)}`);
      if (s.status !== "canceled" && s.status !== "incomplete_expired") await stripe("DELETE", `subscriptions/${encodeURIComponent(s.id)}`);
      await applyStripeSubscription(s.id);
      u.sub = { ...u.sub, refund: { amountCents: o.amount_refunded || 0, currency: o.currency || "usd", at: new Date().toISOString(), id: null, inStripe: true } };
      auth.updateUser(u);
    }
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
