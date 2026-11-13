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
