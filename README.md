# Hearth Calendar

A self-hosted family wall calendar in the style of Skylight. Runs on your own Ubuntu server with Docker. You use it from any web browser, and a tablet or monitor on the wall can run the full-screen display.

- **Accounts.** Everyone gets their own login. The first account becomes the admin.
- **Calendars.** Make calendars inside Hearth, subscribe to read-only ICS links, or **link iCloud, Google, Outlook / Microsoft 365, Fastmail, Nextcloud, or any CalDAV account with two-way sync**. Events you add or edit in Hearth are pushed back to that calendar, so they show up on your phone.
- **Sharing.** Share any calendar or chore list with another account as *view* or *edit*. Each person decides which of their calendars appear in their own view and on their wall displays, and can give shared calendars their own colour.
- **Family members.** Profiles with a colour and emoji (kids don't need accounts). Calendars and chores belong to a person, and you can filter by person.
- **Recurring events.** Daily, weekly (chosen days), monthly, and yearly, with an end date or a repeat count. You can edit or delete *one occurrence*, *this and following*, or *the whole series*. Times stay correct across daylight saving changes.
- **Calendar tools.** Day, week, month and schedule views; search (🔍); a quick-add bar that understands "Soccer Tuesday 5pm" or "Dentist 9/30 at 3:15"; drag an event to another day or time; countdowns ("12 days until Disney") pinned above the calendar; automatic birthdays from family profiles (with ages); and public holiday calendars.
- **Chores and to-dos.** A chore chart with one column per person. Chores can repeat daily, on weekdays, or on chosen days, and reset each day. One-off tasks can have due dates. Chores can be worth ⭐ stars that kids save up and spend on rewards you set.
- **Grocery and to-do lists.** Shared checklists on the **Lists** tab: quick add (paste several lines at once), tap to check off, and "Clear checked". Adding something that's already on the list reuses it, and lists refresh every 15 seconds so two people can shop together. **Usuals** re-add your regular items in one tap, and each item shows who added and checked it.
- **Meal planner.** Plan breakfast, lunch, dinner and snacks by week on the **Meals** tab, reuse past meals, and send ingredients to a grocery list.
- **Phone app.** Install Hearth to your home screen (Android, iPhone, or desktop Chrome/Edge) for its own icon, full-screen window and bottom tab bar. The app shell opens even without a connection; your calendar data is never cached on the device.
- **Reminders.** Push notifications on phones and computers before events, for all-day events in the morning, and for chores still open in the evening.
- **Phone calendar links.** A private, read-only subscribe link per calendar (or all of them) for the iPhone, Google or Outlook calendar apps.
- **Wall display mode.** Big clock, week/month/schedule views, a chore panel and grocery lists you can tap to check off, filter chips for each person, and optional adding and editing. The screen stays awake, returns to today when left idle, and signs in with a revocable link instead of a password. Optional extras: weather, an "up next" card, meals, stars, countdowns, night mode (dims on a schedule), a photo frame when idle, and a portrait layout for a tablet on its side.
- **Looking after itself.** An admin health page (backups, disk space, sync problems, version), email/push alerts when something breaks, and a script that copies the nightly backups to your PC.

## Architecture

```
docker compose
├── db     postgres:17        data in the "db-data" volume
├── app    Node 22 + Express  API + static web app on :3000 (host :8080)
└── caddy  (optional)         automatic HTTPS on 80/443
```

- `app/src/calendar`: every event is stored as its original iCalendar resource (`calendar_objects`). A derived `events` table is used for fast queries, and recurring events are expanded on request. Edits to linked calendars rewrite only the changed properties, so alarms, attendees, and other data from the other app are kept.
- `app/src/sync`: ICS feed polling, CalDAV sync (ctag/etag based, via `tsdav`), and Google OAuth. Linked calendars sync every 15 minutes (configurable). Writes go to the remote server first and use `If-Match`, so a change made on your phone is never silently overwritten.
- `app/public`: plain JavaScript with no build step. `/` is the app, `/display` is the wall display, `/login` is the sign-in page.

## Install on Ubuntu

Tested layout for Ubuntu 22.04/24.04. You need a user with `sudo`.

**1. Install Docker**

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

**2. Copy the project to the server** (for example `scp -r "Shared Calendar" you@server:~/hearth`, or clone your git repo), then:

```bash
cd ~/hearth
cp .env.example .env
sed -i "s/^APP_SECRET=.*/APP_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
nano .env    # set BASE_URL and DEFAULT_TIMEZONE
```

**3. Start it**

```bash
docker compose up -d --build
docker compose logs -f app     # wait for "Hearth Calendar listening"
```

Open `BASE_URL` (for example `http://192.168.1.50:8080`) and create the first account. That account is the administrator.

**4. (Recommended) HTTPS.** HTTPS is needed if you use it outside your home network, and for Google sign-in.

Point a DNS name at the server, open ports 80 and 443, then in `.env` set:

```
BASE_URL=https://calendar.example.com
DOMAIN=calendar.example.com
APP_BIND=127.0.0.1
```

```bash
docker compose --profile https up -d
```

Caddy gets and renews certificates automatically. If you already run nginx or Traefik, leave the profile off and proxy to `127.0.0.1:8080`.

**Alternative: Cloudflare Tunnel** (no open ports; needs a domain on Cloudflare). In the Cloudflare Zero Trust dashboard, create a tunnel (Networks → Tunnels → Create → Cloudflared), copy its token, and add a public hostname such as `calendar.example.com` with service `HTTP` → `app:3000`. Then set `BASE_URL=https://calendar.example.com`, `APP_BIND=127.0.0.1` and `CLOUDFLARE_TUNNEL_TOKEN=<token>` in `.env` and run `docker compose --profile tunnel up -d`. Don't use Caddy at the same time.

### Adding people

Sign-up is closed after the first account (`ALLOW_SIGNUP=false`). As admin, go to **Settings → Users → Add user**:

- **Invite link** (default): Hearth creates the account and gives you a link to send by text or chat, or emails it when email is set up. They open it and choose their own password. Invite links last 7 days.
- **Set a password**: type one yourself and tell them.

To share, open **Settings → Calendars (or Chore lists) → Share** and enter the other person's account email.

**Forgotten passwords:** in **Settings → Users → Reset password**, an admin can create a one-time reset link (valid 2 hours) or set a new password directly. Either way, that person is signed out everywhere. With email set up, people can also use **Forgot password?** on the sign-in page themselves.

### Email (optional)

Email turns on **Forgot password?** links, emailed invites, and an optional **morning summary** (today's and tomorrow's events plus today's chores; each person switches it on in **Settings → Profile**).

Set it up as an admin in **Settings → Email**: pick your provider (Gmail, iCloud, Fastmail, Yahoo or any SMTP server), enter the username and an **app password**, press **Send a test**, then **Save**. For Gmail, turn on 2-Step Verification and create the app password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). The password is stored encrypted with `APP_SECRET`.

The `SMTP_*` variables in `.env` still work as a fallback, but anything saved in Settings → Email takes priority.

### Reminders

Each person turns reminders on per device in **Settings → Profile → Reminders**, and picks when they want them:

- **Events:** 5 minutes to 2 hours before.
- **All-day events:** at 8:00 AM.
- **Unfinished chores:** at a chosen evening hour.

On iPhone and iPad, reminders work in the installed app (iOS 16.4 or newer): add Hearth to the Home Screen first, open it from there, then turn reminders on. Reminders need HTTPS. The server creates its own push keys on first start and stores them in the database.

### Phone calendar subscribe links

**Settings → Calendars → Phone link** (one calendar) or **All my calendars** gives a private link you can add to the iPhone, Google or Outlook calendar apps. It's read-only there and updates automatically. The iPhone refreshes it about every 15 minutes; Google every few hours. Anyone with the link can see those events. Use **Make a new link** to cut off an old one, and links stop working automatically if a calendar stops being shared with you.

### Installing on phones

HTTPS is required (your Cloudflare Tunnel or Caddy setup provides it).

- **Android (Chrome):** open Hearth, tap ⋮ → **Install app** (or use the **Install app** button in Hearth's top bar).
- **iPhone / iPad (Safari):** tap Share → **Add to Home Screen**. Hearth shows a one-time hint about this.
- **Computer (Chrome / Edge):** click the install icon at the right of the address bar.

**Settings → Profile** shows the same instructions.

## Linking calendars

| Provider | How | Direction |
| --- | --- | --- |
| iCloud | Settings → Linked accounts → **+ iCloud / CalDAV**. Use your Apple ID email and an **app-specific password** from account.apple.com → Sign-In and Security. | Two-way |
| Fastmail / Nextcloud / Yahoo / other CalDAV | Same dialog, then choose the preset (use an app password). | Two-way |
| Google | Settings → Linked accounts → **+ Google** (needs the one-time setup below). | Two-way |
| Outlook.com / Microsoft 365 | Settings → Linked accounts → **+ Outlook** (needs the one-time setup below). | Two-way |
| School & team sites | Settings → Calendars → **Subscribe to link**, and paste the ICS/webcal URL. | Read-only |
| Public holidays | Settings → Calendars → **Holidays**, pick a country. | Read-only |

After linking an account, choose which of its calendars to add. Anyone you share a linked calendar with (with *edit*) also writes to it using your saved credentials.

### Linking Google (one-time admin setup)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library**: enable **Google Calendar API** and **CalDAV API**.
3. **OAuth consent screen**: choose External, then **publish the app** (Audience → Publish). In *Testing* mode Google disconnects linked accounts every 7 days. Verification isn't needed for family use; people just click past the "unverified app" notice.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Add the authorised redirect URI `https://YOUR-DOMAIN/api/google/callback` (it must exactly match `BASE_URL` + `/api/google/callback`). Google requires HTTPS here unless you use `http://localhost`.
5. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then run `docker compose up -d`.

### Linking Outlook / Microsoft 365 (one-time admin setup)

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com/) (or portal.azure.com) with any Microsoft account. Go to **App registrations → New registration**.
2. Name it *Hearth*. Under **Supported account types** choose **Accounts in any organizational directory and personal Microsoft accounts**. Under **Redirect URI** choose **Web** and enter `https://YOUR-DOMAIN/api/microsoft/callback` (it must exactly match `BASE_URL` + `/api/microsoft/callback`).
3. On the app's **Overview** page, copy the **Application (client) ID**.
4. **Certificates & secrets → New client secret.** Copy the secret's **Value** (not its ID) straight away; it's only shown once. Secrets expire (24 months at most), so put a reminder in your calendar to make a new one.
5. **API permissions:** make sure Microsoft Graph *delegated* permissions **offline_access**, **User.Read** and **Calendars.ReadWrite** are listed (add the missing ones with **Add a permission → Microsoft Graph → Delegated**). Personal Outlook.com accounts need no admin consent; a work or school account may need its IT admin to approve the app.
6. Put the values in `.env` as `MS_CLIENT_ID` and `MS_CLIENT_SECRET`, then deploy (`.\deploy.cmd`) or run `docker compose up -d`.

Outlook repeat patterns (daily, weekly, monthly, yearly, "second Tuesday") come across as proper series, including changed and deleted occurrences. The rare pattern Hearth can't repeat itself shows as separate events. Hearth's countdown flag is stored on the Outlook event, so it survives syncs.

## Setting up a wall display

1. **Settings → Wall displays → + New display.** Pick the default view (day, week, month or schedule), theme, week start, the panels to show (chores, lists, meals, weather, up next, countdowns), night mode hours, the photo frame, and whether adding things from the display is allowed.
2. Open the link it shows on the tablet or wall computer. The device remembers it, and you can revoke it or issue a new link any time.
3. Choose what appears using the **Show on my wall displays** switches on each calendar and chore list.

Weather needs the household location in **Settings → Household** (admin; uses Open-Meteo, no key needed). Photo frame pictures are uploaded in **Settings → Photos**. Turn the tablet sideways and the display switches to its portrait layout automatically.

Kiosk tips: on an iPad use *Add to Home Screen* and Guided Access. On Android use a kiosk browser such as Fully Kiosk. On a Raspberry Pi run `chromium --kiosk https://your-server/display`.

## Operations

### Deploying updates from Windows

From the project folder on your PC:

```powershell
.\deploy.cmd
```

It backs up the database (keeping the last five in `~/hearth-deploy-backups`), copies the project to the server, rebuilds, and waits until Hearth reports healthy. Options: `-SkipBackup`, `-Server root@1.2.3.4`, `-ComposeProfile https`. It warns if you have changes not yet committed to git.

To avoid typing the server password twice per deploy, set up an SSH key once:

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@YOUR-SERVER-IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

The project is a git repository, so `git log` shows what changed and when, and a bad change can be undone.

### On the server

```bash
# Update after copying new code (add --profile tunnel / https as you use them)
docker compose up -d --build

# Logs / sync errors
docker compose logs -f app
```

### Backups

The `backup` service dumps the database every night at `BACKUP_TIME` (default 03:00 in `DEFAULT_TIMEZONE`) into `./backups` next to `docker-compose.yml`, and deletes dumps older than `BACKUP_KEEP_DAYS` (default 14). It also takes one immediately the first time it starts each day.

```bash
# See backups and the backup log
ls -lh ~/hearth/backups
docker compose logs backup

# Take a backup right now
docker compose exec backup sh /backup.sh now

# Restore (replaces all current data): stop the app, recreate the database, load a dump
docker compose stop app
docker compose exec -T db psql -U hearth -d postgres -c "DROP DATABASE hearth;" -c "CREATE DATABASE hearth OWNER hearth;"
gunzip -c backups/hearth-2026-09-18_0300.sql.gz | docker compose exec -T db psql -U hearth hearth
docker compose start app
```

`./backups` is on the same server, so keep copies elsewhere. From Windows, `.\pull-backups.cmd` downloads any new backups into the `backups` folder next to it (keeping the newest 30), and every `.\deploy.cmd` does the same after deploying. To have Windows do it daily at 5 AM (or whenever the PC is next on), set up SSH key sign-in and run `.\pull-backups.cmd -Schedule` once (`-Unschedule` removes it).

Keep a copy of `.env` with your backups: `APP_SECRET` is required to decrypt saved CalDAV passwords and Google/Microsoft tokens.

### Server health and alerts

**Settings → Server health** (admins) shows the running version, uptime, the latest backup, free disk space, database size, linked calendars that aren't syncing, and recent problems. Hearth checks every 15 minutes and emails and pushes the admins, at most once a day per problem, if backups stop, a linked calendar keeps failing for two hours, the disk gets nearly full, or the server restarted unexpectedly. Turn alerts off or send a test from the same page.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET` | required | Session and credential encryption key (32+ chars) |
| `POSTGRES_PASSWORD` | required | Database password (use hex; it is placed in a URL) |
| `BASE_URL` | `http://localhost:8080` | Public URL; sets secure cookies and the Google redirect |
| `ALLOW_SIGNUP` | `false` | Allow self-registration after the first account |
| `DEFAULT_TIMEZONE` | `America/Chicago` | Used for feeds with floating times |
| `SYNC_INTERVAL_MINUTES` | `15` | How often linked calendars and feeds refresh |
| `SYNC_PAST_DAYS` / `SYNC_FUTURE_DAYS` | `365` / `1095` | Window of linked-calendar events kept in sync |
| `BLOCK_PRIVATE_NETWORKS` | `false` | Reject calendar URLs on private IP ranges |
| `APP_PORT` / `APP_BIND` | `8080` / `0.0.0.0` | Host port and interface for the app |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Enables Google linking |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | empty | Enables Outlook / Microsoft 365 linking |
| `MS_TENANT` | `common` | Set to your organisation's tenant ID to allow only its work accounts |
| `BACKUP_TIME` / `BACKUP_KEEP_DAYS` | `03:00` / `14` | Nightly backup time and retention |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `DIGEST_HOUR` | empty | Fallback email settings; normally set in **Settings → Email** instead |

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies. Every state-changing request needs a custom header (CSRF protection).
- CalDAV passwords and Google/Microsoft refresh tokens are encrypted with AES-256-GCM at rest.
- Display links are long random tokens stored hashed. They can only view calendars and lists marked for displays, tick chores, and (if allowed) edit events. They cannot change settings or sharing.
- Login and registration are rate-limited. The server refuses to fetch loopback and link-local addresses, and can refuse the whole LAN too (`BLOCK_PRIVATE_NETWORKS=true`).
- If the server is reachable from the internet, use HTTPS and keep `ALLOW_SIGNUP=false`.

## Local development

```bash
cd app
npm install
APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://user:pass@localhost:5432/hearth npm run dev
```

## Known limitations

- Linked calendars sync one year back and three years ahead by default.
- Outlook attendees and meeting invitations aren't shown or sent; Hearth edits the event on your own calendar only.
- Photos are stored in the database (up to 300), so they're included in backups; keep them reasonably sized.
