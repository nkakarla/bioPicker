# Deploying BioPicker

One server serves everyone: the website, the iPhone app (which shows the same web pages), and the public watch links. Deploy the server and every platform gets the change. Only changes under `ios/` need a new App Store build.

## Requirements
Node 20+, ffmpeg/ffprobe on PATH, and `npm ci` after every pull.

## Environment
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | AI features (unchanged) |
| `HOST`, `PORT`, `DATA_DIR` | unchanged |
| `SIGNUPS=closed` | optional: stop new accounts (existing ones still sign in) |
| `ADMIN_USERS` | optional: comma-separated usernames that get the admin panel (default `nkakarla`) |
| `CLAUDE_MODEL` | optional: default AI model (default `claude-sonnet-5`); the admin panel's choice overrides it |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | optional: card payments on the website (see "Payments" below) |
| `APPLE_BUNDLE_ID` | optional: the iPhone app's bundle id for In-App Purchase checks (default `com.eperf.biopicker`) |
| `PUBLIC_URL` | optional: the site's address for Stripe's return links (default: the address the request came in on) |
| `GEOIP=off` | optional: don't download the DB-IP place database (sign-in places then show as unknown) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | optional: warning emails to the admin (free spots running out). Google Workspace / Gmail: `smtp.gmail.com`, `587`, the full address, and an app password (Google Account → Security → App passwords). Without them warnings only show in the admin panel |
| `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | optional: "your film is ready" notifications on iPhone. Key from developer.apple.com → Keys → APNs. `APNS_TEAM_ID=XKQ3C2A6A9`, `APNS_TOPIC=com.eperf.biopicker` |
| ~~`APP_PASSCODE`~~ | no longer used: accounts replace the shared passcode |

Keep the `.p8` key outside the repo (the GitHub repo is public).

Session cookies are marked `Secure` when the request came over HTTPS. Behind Apache, make sure it forwards the scheme: `RequestHeader set X-Forwarded-Proto "https"` in the HTTPS virtual host.

## Upgrading from 1.0 (passcode) to 1.1 (accounts)
Biopics made before accounts have no owner. They stay hidden until they're given to an account.

1. Back up `data/` (or your `DATA_DIR`).
2. `git pull && npm ci`, then restart the server.
3. Stop the server, create your account and give it the old biopics, start it again:
   ```
   node scripts/admin.js add-user <your-username> <password>
   node scripts/admin.js claim <your-username>
   ```
   (Or create the account on the site with **Create an account**, then stop the server and run only `claim`.)

Accounts are username + password. Sign-in limits repeated wrong passwords (10 per 15 minutes per account and per address).

## Admin panel, plans and usage (1.2)
Admins (see `ADMIN_USERS`) get **Admin panel** in the account menu (`/admin.html`):
- **Usage & cost:** AI cost and tokens by film level (short, long, episode, biopic setup), by AI task, by model and by month; films rendered, film minutes and render time. Export everything as CSV.
- **Accounts:** every account with its plan, renders and AI cost; open one to change its plan or limits, turn it off (signs it out everywhere), or set a new password. Changes apply at once, no restart needed.
- **Plans & paywall:** plans (renders per month, AI budget per month in US$, series included), which plan new accounts and admins get, the paywall message and upgrade link, and the AI price table.

Every Claude call and every finished render is appended to `DATA_DIR/usage.jsonl`; the plans, paywall and prices live in `DATA_DIR/billing.json`. Both are included when you back up `data/`. Costs are computed from the token counts and the price table, so correcting a price re-prices past months. Tracking starts when 1.2 is deployed; earlier work isn't counted.

Limits stop new work only: a render or AI request that would go over the plan is refused with a message (HTTP 402); work already running finishes. Failed renders don't count. When plans can be bought (below), the message offers them; otherwise, with the paywall option on, it carries an **Upgrade** link you choose and you set the person's plan by hand.

**AI model:** Plans & paywall → AI prices → "Model BioPicker uses". Default Claude Sonnet 5. Takes effect on the next AI call.

**Sign-ups:** Plans & paywall → Sign-ups: the most free accounts (blank = no cap), new accounts per IP address per day (default 3), and what happens when the free spots are full (stop sign-ups with your message, or let people sign up with no plan until they pay). Accounts you create or give a plan to don't use a free spot. An account waiting for a plan has a **Give a free spot** button on its page.

**Free-spot warnings:** on the same card, "Warn me when this many free spots are used" and an email address. Each new free account at or above that number sends an email (so at 8, 9 and 10 of 10), and once the count drops below it the next crossing warns again. When the spots are full and someone is turned away you get at most one email a day. While it applies, every admin page shows a ⚠ banner and the Free spots tile is marked. **Send a test email** checks the SMTP settings; the last emails and their results are listed under it. State lives in `DATA_DIR/alerts.json`.

**Where accounts come from:** sign-up IP, approximate place (city/region/country), device, and the referring page; the last 10 sign-ins; and "last seen" (updated at most every 6 hours). Places come from the free DB-IP City Lite database, downloaded to `DATA_DIR/geoip` (about 130 MB) shortly after start and refreshed monthly; no visitor IP is sent elsewhere. The admin panel shows the required "IP Geolocation by DB-IP" credit.

### Payments
A plan is for sale when it has a **Stripe price id** (website) and/or an **Apple product id** (iPhone app), set on Plans & paywall. People choose under Account settings → See plans, or when they reach a limit. A paid subscription sets their plan until it ends; a plan you set by hand on their account page overrides it.

**Stripe (website):**
1. In the Stripe dashboard create a Product per paid plan with a monthly recurring Price; copy each `price_…` id into the plan.
2. Developers → Webhooks → add the endpoint shown on Plans & paywall (`https://biopicker.eperflabs.com/api/pay/stripe/webhook`) with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret.
3. Settings → Billing → Customer portal: turn on cancel and plan switching (the "Manage" link uses it).
4. Put `STRIPE_SECRET_KEY` (use a restricted key or `sk_test_…` first) and `STRIPE_WEBHOOK_SECRET` in the server's `.env`, restart.
Test mode keys and test cards (4242 4242 4242 4242) work end to end; the admin panel marks test subscriptions "(test)". Deleting a BioPicker account cancels its Stripe subscription.

**Apple (iPhone app):** see `ios/README.md` → In-App Purchase. Put the notifications address shown on Plans & paywall into App Store Connect → App Information → App Store Server Notifications (Version 2), for both Production and Sandbox. The server checks every purchase and notification against Apple's root certificate (`lib/certs/AppleRootCA-G3.cer`). Sandbox (TestFlight, App Review) purchases are accepted and marked "(sandbox)".

## Admin
Run on the server (stop the server first for `add-user`, `claim`, `reset-password` and `unpublish`):
```
node scripts/admin.js users                          # accounts and biopic counts
node scripts/admin.js add-user <name> <pw>           # create an account
node scripts/admin.js claim <username>               # give unowned (pre-1.1) biopics to an account
node scripts/admin.js reset-password <name> <pw>     # forgot password: set a new one, sign out everywhere
node scripts/admin.js reports                # reports about public biopics
node scripts/admin.js unpublish <projectId>  # take a public biopic down
```
Reports also appear in the server log as `[report]`.
