// BioPicker — usage tracking (AI tokens and renders), plans, monthly limits and the paywall config.
// Copyright (c) 2026 EPerf
//
// Every Claude call and every finished render is appended to DATA_DIR/usage.jsonl with the account, biopic,
// film version and level it belongs to. Costs are computed from the token counts with the price table in
// DATA_DIR/billing.json, so correcting a price there re-prices all history.
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadProject } from "./store.js";
import { DATA_DIR, ensureDir } from "./util.js";

ensureDir(DATA_DIR);
const USAGE_FILE = path.join(DATA_DIR, "usage.jsonl");
const BILLING_FILE = path.join(DATA_DIR, "billing.json");

// ---------- who is the work for? ----------
// Requests and background jobs carry a small context (account, biopic, film version, job type) so that an
// AI call deep inside a job is still charged to the right account and film level.
const als = new AsyncLocalStorage();
export const usageContext = () => als.getStore() || {};
/** Runs fn with extra context fields (e.g. the film version an episode script is written for). */
export const withUsage = (extra, fn) => als.run({ ...usageContext(), ...extra }, fn);
/** Express middleware: every request gets its own context, filled in as routing learns more. */
export const usageMiddleware = (req, res, next) => als.run({ userId: req.user?.id || null }, next);
export const setUsage = (extra) => {
  const s = als.getStore();
  if (s) Object.assign(s, extra);
};

/** short | long | episode | setup (work for the whole biopic: photos, documents, interview, history, voice, series plan). */
export const levelOf = (version) => (!version ? "setup" : version === "short" ? "short" : version === "long" ? "long" : "episode");
export const LEVELS = ["short", "long", "episode", "setup"];

// ---------- billing config ----------
// Prices are US dollars per million tokens (Anthropic first-party API rates; 5-minute cache writes).
const DEFAULT_BILLING = {
  prices: {
    "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  },
  plans: [
    { id: "free", name: "Free", priceMonthly: 0, rendersPerMonth: 3, aiBudgetMonthly: 2, series: false, description: "Try BioPicker: a few films a month.", stripePriceId: "", appleProductId: "" },
    { id: "plus", name: "Plus", priceMonthly: 9.99, rendersPerMonth: 20, aiBudgetMonthly: 15, series: true, description: "More films each month, and documentary series.", stripePriceId: "", appleProductId: "" },
    { id: "unlimited", name: "Unlimited (staff & family)", priceMonthly: 0, rendersPerMonth: null, aiBudgetMonthly: null, series: true, description: "No limits. Given by the admin.", stripePriceId: "", appleProductId: "" },
  ],
  defaultPlan: "free",
  adminPlan: "unlimited",
  // the Claude model for all AI work (null: CLAUDE_MODEL from the environment, else claude-sonnet-5)
  aiModel: null,
  signups: {
    freeMax: null, // most accounts on the free (new-account) plan; null = no cap
    perIpPerDay: 3, // new accounts from one IP address per 24 hours; null = no limit
    whenFull: "closed", // "closed": refuse new accounts | "paid": create them without a plan until they subscribe
    fullMessage: "BioPicker's free spots are full right now. Please try again later.",
    alertAt: null, // email the admin (and flag the admin panel) when this many free spots are used; null = off
    alertEmail: "",
  },
  paywall: {
    enabled: false,
    message: "Upgrade your plan to keep going this month.",
    upgradeUrl: "",
    provider: "manual",
  },
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
let billing = { ...DEFAULT_BILLING, ...readJSON(BILLING_FILE, {}) };
billing.paywall = { ...DEFAULT_BILLING.paywall, ...billing.paywall };
billing.signups = { ...DEFAULT_BILLING.signups, ...billing.signups };
billing.plans = billing.plans.map((p) => ({ stripePriceId: "", appleProductId: "", ...p }));
export const getBilling = () => billing;

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const payId = (v, re, hint) => {
  const s = String(v || "").trim();
  if (s && !re.test(s)) throw err(400, `“${s}”: ${hint}.`);
  return s;
};
const limitNum = (v, what) => {
  if (v === null || v === undefined || v === "") return null; // no limit
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${what} must be a number of 0 or more, or blank for no limit.`);
  return n;
};

/** Validates and saves an edited billing config from the admin panel. */
export function saveBilling(b) {
  const plans = (Array.isArray(b?.plans) ? b.plans : []).map((p) => {
    const id = String(p.id || "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,24}$/.test(id)) throw err(400, `Plan id “${p.id}” must be 2–24 lowercase letters, numbers or dashes.`);
    return {
      id,
      name: String(p.name || id).slice(0, 60),
      priceMonthly: limitNum(p.priceMonthly, "Price") ?? 0,
      rendersPerMonth: limitNum(p.rendersPerMonth, "Renders per month"),
      aiBudgetMonthly: limitNum(p.aiBudgetMonthly, "AI budget"),
      series: !!p.series,
      description: String(p.description || "").slice(0, 300),
      stripePriceId: payId(p.stripePriceId, /^price_[A-Za-z0-9]{6,80}$/, "Stripe price ids look like price_1Abc…"),
      appleProductId: payId(p.appleProductId, /^[A-Za-z0-9._-]{2,100}$/, "Apple product ids are letters, numbers, dots, dashes or underscores"),
    };
  });
  for (const key of ["stripePriceId", "appleProductId"]) {
    const ids = plans.map((p) => p[key]).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw err(400, "Two plans have the same payment id.");
  }
  if (!plans.length) throw err(400, "Keep at least one plan.");
  if (new Set(plans.map((p) => p.id)).size !== plans.length) throw err(400, "Two plans have the same id.");
  const ids = new Set(plans.map((p) => p.id));
  const defaultPlan = String(b.defaultPlan || "");
  const adminPlan = String(b.adminPlan || "");
  if (!ids.has(defaultPlan)) throw err(400, "Choose which plan new accounts get.");
  if (!ids.has(adminPlan)) throw err(400, "Choose which plan admins get.");
  const prices = {};
  for (const [model, pr] of Object.entries(b.prices || {})) {
    const m = String(model).trim();
    if (!/^[a-z0-9.-]{3,60}$/.test(m)) throw err(400, `“${model}” doesn't look like a model id.`);
    prices[m] = {
      input: limitNum(pr.input, `${m} input price`) ?? 0,
      output: limitNum(pr.output, `${m} output price`) ?? 0,
      cacheWrite: limitNum(pr.cacheWrite, `${m} cache write price`) ?? 0,
      cacheRead: limitNum(pr.cacheRead, `${m} cache read price`) ?? 0,
    };
  }
  const pw = b.paywall || {};
  const upgradeUrl = String(pw.upgradeUrl || "").trim();
  if (upgradeUrl && !/^https?:\/\//i.test(upgradeUrl)) throw err(400, "The upgrade link must start with https:// (or http://).");
  const aiModel = b.aiModel ? String(b.aiModel) : null;
  if (aiModel && !prices[aiModel]) throw err(400, `Add a price for ${aiModel} before choosing it as the AI model.`);
  const su = b.signups || {};
  const whole = (v, what) => {
    const n = limitNum(v, what);
    if (n != null && !Number.isInteger(n)) throw err(400, `${what} must be a whole number.`);
    return n;
  };
  const alertEmail = (v) => {
    const e = String(v || "").trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err(400, `“${e}” doesn't look like an email address.`);
    return e.slice(0, 200);
  };
  billing = {
    prices,
    plans,
    defaultPlan,
    adminPlan,
    aiModel,
    signups: {
      freeMax: whole(su.freeMax, "Free accounts"),
      perIpPerDay: whole(su.perIpPerDay, "Accounts per address per day"),
      whenFull: su.whenFull === "paid" ? "paid" : "closed",
      fullMessage: String(su.fullMessage || DEFAULT_BILLING.signups.fullMessage).slice(0, 300),
      alertAt: whole(su.alertAt, "Warn me at"),
      alertEmail: alertEmail(su.alertEmail),
    },
    paywall: {
      enabled: !!pw.enabled,
      message: String(pw.message || "").slice(0, 500),
      upgradeUrl,
      provider: ["manual", "stripe", "apple"].includes(pw.provider) ? pw.provider : "manual",
    },
  };
  const tmp = `${BILLING_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(billing, null, 2));
  fs.renameSync(tmp, BILLING_FILE);
  return billing;
}

// ---------- admins and plans ----------
const ADMINS = new Set(String(process.env.ADMIN_USERS || "nkakarla").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
export const isAdmin = (u) => !!u && ADMINS.has(u.username);
export const planById = (id) => billing.plans.find((p) => p.id === id) || null;
/** A paid subscription (Stripe or Apple) that is still running: active, or cancelled but not yet at the end of the paid period. */
export function activeSub(u) {
  const s = u?.sub;
  if (!s || !planById(s.planId)) return null;
  if (!["active", "trialing", "past_due", "grace"].includes(s.status)) return null;
  if (s.periodEnd && Date.parse(s.periodEnd) + 864e5 < Date.now()) return null; // a day's slack for late renewals
  return s;
}
/** Accounts created after the free spots ran out (sign-ups set to "paid"): no plan until they subscribe or the admin gives one. */
const NO_PLAN = { id: "none", name: "No plan yet", priceMonthly: 0, rendersPerMonth: 0, aiBudgetMonthly: 0, series: false, description: "Choose a plan to start making films.", stripePriceId: "", appleProductId: "" };
/** The plan an account is on: the one the admin set, else a paid subscription, else the admin or new-account default. */
export function planOf(u) {
  const set = planById(u?.plan);
  if (set) return set;
  const sub = activeSub(u);
  if (sub) return planById(sub.planId);
  if (u?.needsPlan && !isAdmin(u)) return NO_PLAN;
  return planById(isAdmin(u) ? billing.adminPlan : billing.defaultPlan) || billing.plans[0];
}
/** How the account got its plan: admin | subscription | waiting | default. */
export function planSource(u) {
  if (planById(u?.plan)) return "admin";
  if (activeSub(u)) return "subscription";
  if (u?.needsPlan && !isAdmin(u)) return "waiting";
  return "default";
}
/** Accounts using a free spot: on the new-account plan by default (not set by the admin, not paying, not waiting, not turned off). */
export const freeAccounts = (users) => users.filter((u) => !u.disabled && !isAdmin(u) && planSource(u) === "default");

/** Sign-up rules from the admin panel. Throws when sign-ups are refused; returns extra fields for the new account. */
export function signupGate(users, ip) {
  const s = billing.signups;
  if (s.perIpPerDay != null && ip && ip !== "?") {
    const since = Date.now() - 864e5;
    const n = users.filter((u) => u.signup?.ip === ip && Date.parse(u.signup.at) > since).length;
    if (n >= s.perIpPerDay) throw err(429, "Too many new accounts from this network today. Please try again tomorrow.");
  }
  if (s.freeMax != null && freeAccounts(users).length >= s.freeMax) {
    if (s.whenFull === "paid") return { needsPlan: true };
    throw err(403, s.fullMessage, { signupsFull: true });
  }
  return {};
}

/** The account's limits: per-account overrides win over the plan's. null = no limit. */
export function limitsOf(u) {
  const plan = planOf(u);
  if (plan === NO_PLAN) return { rendersPerMonth: 0, aiBudgetMonthly: 0, series: false };
  const o = u?.limits || {};
  return {
    rendersPerMonth: "rendersPerMonth" in o ? o.rendersPerMonth : plan.rendersPerMonth,
    aiBudgetMonthly: "aiBudgetMonthly" in o ? o.aiBudgetMonthly : plan.aiBudgetMonthly,
    series: "series" in o ? o.series : plan.series,
  };
}

// ---------- the usage log ----------
const events = [];
try {
  for (const line of fs.readFileSync(USAGE_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
} catch {}
export const allEvents = () => events;

const ownerCache = new Map();
function ownerOf(projectId) {
  if (!projectId) return null;
  if (!ownerCache.has(projectId)) {
    try {
      ownerCache.set(projectId, loadProject(projectId).ownerId || null);
    } catch {
      return null;
    }
  }
  return ownerCache.get(projectId);
}

function append(e) {
  events.push(e);
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify(e) + "\n");
  } catch (x) {
    console.error("[usage] could not write the usage log:", x.message);
  }
}

/** Records one Claude response. Each attempt (including a fallback model's) is its own line, priced at its own model. */
export function recordAI(task, requestedModel, msg) {
  const c = usageContext();
  const base = {
    t: "ai",
    at: new Date().toISOString(),
    userId: c.userId || ownerOf(c.projectId),
    projectId: c.projectId || null,
    version: c.version || null,
    level: levelOf(c.version),
    job: c.jobType || null,
    task,
  };
  const line = (model, u, fallback) => append({
    ...base,
    model: model || requestedModel,
    in: u?.input_tokens || 0,
    out: u?.output_tokens || 0,
    cr: u?.cache_read_input_tokens || 0,
    cw: u?.cache_creation_input_tokens || 0,
    ...(fallback ? { fallback: true } : {}),
  });
  const iterations = msg?.usage?.iterations;
  if (Array.isArray(iterations) && iterations.length) {
    for (const it of iterations) {
      const fb = it.type === "fallback_message";
      line(it.model || (fb ? msg.model : requestedModel), it, fb);
    }
  } else line(msg?.model, msg?.usage, false);
}

/** Records a finished (or failed) render. */
export function recordRender({ projectId, version, status, filmSeconds, wallSeconds, error }) {
  append({
    t: "render",
    at: new Date().toISOString(),
    userId: ownerOf(projectId),
    projectId,
    version,
    level: levelOf(version),
    status,
    filmSeconds: Math.round(filmSeconds || 0),
    wallSeconds: Math.round(wallSeconds || 0),
    ...(error ? { error: String(error).slice(0, 300) } : {}),
  });
}

// ---------- money ----------
export function costOf(e) {
  if (e.t !== "ai") return 0;
  const p = billing.prices[e.model];
  if (!p) return 0;
  return (e.in * p.input + e.out * p.output + e.cw * p.cacheWrite + e.cr * p.cacheRead) / 1e6;
}
export const unpricedModels = () => [...new Set(events.filter((e) => e.t === "ai" && !billing.prices[e.model]).map((e) => e.model))];

export const monthOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const thisMonth = () => monthOf(new Date().toISOString());

/** Totals for a set of events: AI cost/tokens/calls and renders (done, failed, film minutes, render time). */
export function totals(list) {
  const t = { aiCost: 0, aiCalls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, renders: 0, rendersFailed: 0, filmSeconds: 0, renderSeconds: 0 };
  for (const e of list) {
    if (e.t === "ai") {
      t.aiCost += costOf(e);
      t.aiCalls++;
      t.tokensIn += e.in;
      t.tokensOut += e.out;
      t.cacheRead += e.cr;
      t.cacheWrite += e.cw;
    } else if (e.t === "render") {
      if (e.status === "done") {
        t.renders++;
        t.filmSeconds += e.filmSeconds || 0;
      } else t.rendersFailed++;
      t.renderSeconds += e.wallSeconds || 0;
    }
  }
  return t;
}
/** Groups events by a key function and totals each group. */
export function groupTotals(list, keyFn) {
  const groups = new Map();
  for (const e of list) {
    const k = keyFn(e);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()].map(([key, l]) => ({ key, ...totals(l) }));
}
export const eventsFor = (userId, month) => events.filter((e) => e.userId === userId && (!month || monthOf(e.at) === month));

// ---------- limits ----------
// set by payments.js: true when people can subscribe to a plan in BioPicker itself (Stripe or Apple)
let canSubscribe = () => false;
export const setSubscribeCheck = (fn) => (canSubscribe = fn);
function limitError(u, message) {
  const pw = billing.paywall;
  const plan = planOf(u);
  const extra = plan === NO_PLAN ? "Choose a plan to start making films." : pw.message;
  // plans for sale here (Stripe or Apple): always offer them; otherwise the admin's upgrade link, if turned on
  if (canSubscribe()) return err(402, `${message} ${extra}`.trim(), { paywall: true, plans: true, upgradeUrl: "", plan: plan.name });
  if (pw.enabled && pw.upgradeUrl) return err(402, `${message} ${extra}`.trim(), { paywall: true, plans: false, upgradeUrl: pw.upgradeUrl, plan: plan.name });
  return err(402, `${message} Ask the person who runs BioPicker if you need more.`, { paywall: false, plan: plan.name });
}

/** Account usage for this month, as the account and the admin panel see it. */
export function monthUsage(u, activeRenders = 0) {
  const t = totals(eventsFor(u.id, thisMonth()));
  const lim = limitsOf(u);
  return {
    month: thisMonth(),
    plan: planOf(u),
    limits: lim,
    rendersUsed: t.renders + activeRenders,
    aiCost: t.aiCost,
    // share of the AI allowance used; a $0 allowance counts as fully used, no allowance as null
    aiShare: lim.aiBudgetMonthly == null ? null : lim.aiBudgetMonthly === 0 ? 1 : Math.min(1, t.aiCost / lim.aiBudgetMonthly),
  };
}

/** Throws a 402 if starting these renders would go over the account's monthly limit, or the plan has no series. */
export function checkRender(u, versions, activeRenders) {
  if (!u) return;
  if (planOf(u) === NO_PLAN) throw limitError(u, "Your account doesn't have a plan yet.");
  const lim = limitsOf(u);
  if (!lim.series && versions.some((v) => v.startsWith("ep"))) throw limitError(u, `Documentary series aren't part of your plan (${planOf(u).name}).`);
  if (lim.rendersPerMonth == null) return;
  const used = monthUsage(u, activeRenders).rendersUsed;
  if (used + versions.length > lim.rendersPerMonth) {
    const left = Math.max(0, lim.rendersPerMonth - used);
    throw limitError(u, left
      ? `Your plan has ${left} film render${left === 1 ? "" : "s"} left this month, and this needs ${versions.length}.`
      : `You've used all ${lim.rendersPerMonth} film renders in your plan this month.`);
  }
}

/** Throws a 402 when the account has used its AI allowance this month, or wants series work the plan doesn't include. */
export function checkAI(u, { series = false } = {}) {
  if (!u) return;
  if (planOf(u) === NO_PLAN) throw limitError(u, "Your account doesn't have a plan yet.");
  const lim = limitsOf(u);
  if (series && !lim.series) throw limitError(u, `Documentary series aren't part of your plan (${planOf(u).name}).`);
  if (lim.aiBudgetMonthly == null) return;
  if (monthUsage(u).aiCost >= lim.aiBudgetMonthly) throw limitError(u, "You've used this month's AI allowance in your plan.");
}
