# Hearth Calendar

**Website:** https://jewaldt27.github.io/hearth-calendar/

A self-hosted family wall calendar in the style of Skylight. Runs on your own Ubuntu server with Docker. You use it from any web browser, and a tablet or monitor on the wall can run the full-screen display.

**Install on Ubuntu or Debian with one command:**

```bash
curl -fsSL https://raw.githubusercontent.com/JEwaldt27/hearth-calendar/main/install.sh | sudo bash
```

See [Install](#install-on-ubuntu) for what it does and other ways to install.

- **Accounts.** Everyone gets their own login. The first account becomes the admin.
- **Calendars.** Make calendars inside Hearth, subscribe to read-only ICS links, or **link iCloud, Google, Outlook / Microsoft 365, Fastmail, Nextcloud, or any CalDAV account with two-way sync**. Events you add or edit in Hearth are pushed back to that calendar, so they show up on your phone.
- **Sharing.** Share any calendar or list (chores, groceries, meal plans) with another account as *view* or *edit*. Each person decides which of their calendars appear in their own view and on their wall displays, and can give shared calendars their own colour.
- **Family members.** Profiles with a colour and emoji (kids don't need accounts). Calendars and chores belong to a person, and you can filter by person.
- **Recurring events.** Daily, weekly (chosen days), monthly, and yearly, with an end date or a repeat count. You can edit or delete *one occurrence*, *this and following*, or *the whole series*. Times stay correct across daylight saving changes.
- **Calendar tools.** Day, week, month and schedule views; search (🔍); a quick-add bar that understands "Soccer Tuesday 5pm" or "Dentist 9/30 at 3:15"; drag an event to another day or time; countdowns ("12 days until Disney") pinned above the calendar; automatic birthdays from family profiles (with ages); and public holiday calendars.
- **Chores and to-dos.** A chore chart with one column per person. Chores can repeat daily, on weekdays, or on chosen days, and reset each day. One-off tasks can have due dates. Chores can be worth ⭐ stars that kids save up and spend on rewards you set.
- **Grocery and to-do lists.** Shared checklists on the **Lists** tab: quick add (paste several lines at once), tap to check off, and "Clear checked". Adding something that's already on the list reuses it, and lists refresh every 15 seconds so two people can shop together. **Usuals** re-add your regular items in one tap, and each item shows who added and checked it.
- **Meal planner.** Plan breakfast, lunch, dinner and snacks by week on the **Meals** tab, reuse past meals, and send ingredients to a grocery list.
- **Phone app.** Install Hearth to your home screen (Android, iPhone, or desktop Chrome/Edge) for its own icon, full-screen window and bottom tab bar. The app shell opens even without a connection; your calendar data is never cached on the device.
- **Reminders.** Push notifications on phones and computers before events, for all-day events in the morning, and for chores still open in the evening.
- **Phone calendar links.** A private, read-only subscribe link per calendar (or all of them) for the iPhone, Google or Outlook calendar apps.
- **Wall display mode.** Big clock, day/week/month/schedule views, a chore panel and grocery lists you can tap to check off, filter chips for each person, and optional adding and editing. The screen stays awake, returns to today when left idle, and signs in with a revocable link instead of a password. Optional extras: weather, an "up next" card, meals, stars, countdowns, night mode (dims on a schedule), a photo frame when idle, and a portrait layout for a tablet on its side.
- **Looking after itself.** An admin health page (backups, disk space, sync problems, version), email/push alerts when something breaks, and a script that copies the nightly backups to your PC.

## Architecture

```
docker compose
├── db           postgres:17        data in the "db-data" volume
├── app          Node 22 + Express  API + static web app on :3000 (host :8080)
│                 image: ghcr.io/jewaldt27/hearth-calendar (amd64 + arm64)
├── backup       postgres:17        nightly database dumps into ./backups
├── caddy        (profile https)    automatic HTTPS on 80/443
└── cloudflared  (profile tunnel)   Cloudflare Tunnel, no open ports
```

- `app/src/calendar`: every event is stored as its original iCalendar resource (`calendar_objects`). A derived `events` table is used for fast queries, and recurring events are expanded on request. Edits to linked calendars rewrite only the changed properties, so alarms, attendees, and other data from the other app are kept.
- `app/src/sync`: ICS feed polling, CalDAV sync (ctag/etag based, via `tsdav`), Google (OAuth + CalDAV), and Outlook / Microsoft 365 (OAuth + Microsoft Graph, converted to and from iCalendar). Linked calendars sync every 15 minutes (configurable). Writes go to the remote server first and use `If-Match`, so a change made on your phone is never silently overwritten.
- `app/src/lib`: accounts, email, push reminders, morning summaries, weather, birthdays, and the health checks and alerts. Background jobs run inside the app; there is no separate worker.
- `app/public`: plain JavaScript with no build step. `/` is the app, `/display` is the wall display, `/login` is the sign-in page.

## Install on Ubuntu

Works on Ubuntu 22.04/24.04 and Debian 12, on regular PCs and servers (amd64) or a Raspberry Pi 4/5 (arm64, 64-bit OS).

### Quick install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/JEwaldt27/hearth-calendar/main/install.sh | sudo bash
```

The installer:

1. installs Docker if it isn't already there;
2. downloads the Docker Compose setup into `hearth` in your home folder (for example `/home/you/hearth`);
3. creates `~/hearth/.env` with freshly generated secrets;
4. asks how people will reach Hearth (home network only, built-in HTTPS with your domain, or a Cloudflare Tunnel) and your time zone;
5. downloads the Hearth image from GitHub and starts it.

The home folder is used because every kind of Docker can read it, including the sandboxed snap version offered during Ubuntu Server setup. If Docker still can't read it, the installer moves everything to `/var/snap/docker/common/hearth` and says so. Set `HEARTH_DIR` to choose another folder.

**To update**, run the same command again. It backs up the database into `backups/`, keeps your `.env` and all your data, downloads the newest version, and restarts. This also works on a server that was set up by hand or with `deploy.cmd`: run it as root and it uses the existing `~/hearth` folder, and keeps a running Cloudflare Tunnel or Caddy by adding `COMPOSE_PROFILES` to `.env`. To change settings later, edit `~/hearth/.env` (with `sudo`) and run the command again.

For an unattended install, set the answers as environment variables, for example `curl -fsSL …/install.sh | sudo HEARTH_BASE_URL=http://192.168.1.50:8080 HEARTH_TIMEZONE=America/Chicago bash`. The other options (`HEARTH_DIR`, `HEARTH_DOMAIN`, `HEARTH_TUNNEL_TOKEN`, `HEARTH_REF`) are listed at the top of [install.sh](install.sh).

### Manual install

**1. Install Docker**

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in afterwards
```

**2. Get the files** by cloning this repository (`git clone https://github.com/JEwaldt27/hearth-calendar.git ~/hearth`), then:

```bash
cd ~/hearth
cp .env.example .env
sed -i "s/^APP_SECRET=.*/APP_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
nano .env    # set BASE_URL and DEFAULT_TIMEZONE
```

**3. Start it**

```bash
docker compose up -d           # downloads the published image
docker compose logs -f app     # wait for "Hearth Calendar listening"
```

To build the image from your copy of the code instead (for example after changing it), use `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

Open `BASE_URL` (for example `http://192.168.1.50:8080`) and create the first account. That account is the administrator.

**4. (Recommended) HTTPS.** HTTPS is needed if you use it outside your home network, and for Google and Outlook linking, push reminders, and installing Hearth as a phone app.

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

**Alternative: Cloudflare Tunnel** (no open ports; needs a domain on Cloudflare). In the Cloudflare Zero Trust dashboard, create a tunnel (Networks → Tunnels → Create → Cloudflared), copy its token, and add a public hostname such as `calendar.example.com` with service `HTTP` → `app:3000`. Then set `BASE_URL=https://calendar.example.com`, `APP_BIND=127.0.0.1` and `CLOUDFLARE_TUNNEL_TOKEN=<token>` in `.env` and run `docker compose --profile tunnel up -d`. Adding `COMPOSE_PROFILES=tunnel` (or `https`) to `.env` makes plain `docker compose up -d` include it automatically. Don't use Caddy at the same time.

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
.\deploy.cmd -Server root@YOUR-SERVER-IP   # the first time
.\deploy.cmd                             # after that
```

The server address is remembered in `deploy.server`, which is not committed to git. It backs up the database (keeping the last five in `~/hearth-deploy-backups`), copies the project to the server, builds the image from that code, stamps the git commit as the version (shown in **Settings → Server health**), rebuilds, waits until Hearth reports healthy, and then copies any new nightly backups to your PC. Options: `-SkipBackup`, `-Server root@1.2.3.4`, `-ComposeProfile https`, `-RemoteDir /home/you/hearth` (if the installer was run by a user other than root). It warns if you have changes not yet committed to git.

To avoid typing the server password several times per deploy (and to let scheduled backup copies run on their own), set up an SSH key once:

```powershell
ssh-keygen -t ed25519
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@YOUR-SERVER-IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

The project is a git repository, so `git log` shows what changed and when, and a bad change can be undone.

### On the server

```bash
# Update to the newest published version (add --profile tunnel / https unless COMPOSE_PROFILES is set in .env)
docker compose pull && docker compose up -d

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

### Releases

Every push to `main` publishes `ghcr.io/jewaldt27/hearth-calendar:latest` (plus a tag for the commit) through GitHub Actions. Tagging a commit `v1.2.3` also publishes `1.2.3` and `1.2`. Set `HEARTH_VERSION=1.2.3` in `.env` to stay on a release instead of following `latest`.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEARTH_VERSION` | `latest` | Image tag to run |
| `COMPOSE_PROFILES` | empty | Add-ons started by plain `docker compose up -d`: `https`, `tunnel` |
| `APP_SECRET` | required | Session and credential encryption key (32+ chars) |
| `POSTGRES_PASSWORD` | required | Database password (use hex; it is placed in a URL) |
| `BASE_URL` | `http://localhost:8080` | Public URL; sets secure cookies, links in emails, and the Google/Outlook redirects |
| `ALLOW_SIGNUP` | `false` | Allow self-registration after the first account |
| `DEFAULT_TIMEZONE` | `America/Chicago` | Household time zone: reminders, morning summaries, backups, Outlook times, and feeds that don't name one |
| `SYNC_INTERVAL_MINUTES` | `15` | How often linked calendars and feeds refresh |
| `SYNC_PAST_DAYS` / `SYNC_FUTURE_DAYS` | `365` / `1095` | Window of linked-calendar events kept in sync |
| `BLOCK_PRIVATE_NETWORKS` | `false` | Reject calendar URLs on private IP ranges |
| `APP_PORT` / `APP_BIND` | `8080` / `0.0.0.0` | Host port and interface for the app |
| `DOMAIN` | empty | Domain for the Caddy HTTPS profile |
| `CLOUDFLARE_TUNNEL_TOKEN` | empty | Token for the Cloudflare Tunnel profile |
| `COOKIE_SECURE` | on when `BASE_URL` is https | Force `Secure` cookies on or off |
| `TRUST_PROXY` | `true` | Trust `X-Forwarded-*` from a proxy on the same machine or private network (Caddy, cloudflared) |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Enables Google linking |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | empty | Enables Outlook / Microsoft 365 linking |
| `MS_TENANT` | `common` | Set to your organisation's tenant ID to allow only its work accounts |
| `BACKUP_TIME` / `BACKUP_KEEP_DAYS` | `03:00` / `14` | Nightly backup time and retention |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` / `DIGEST_HOUR` | empty | Fallback email settings; normally set in **Settings → Email** instead |

Weather location and units, email, and problem alerts are set in the app (Settings → Household, Email and Server health), not in `.env`.

## Security notes

- Passwords are hashed with scrypt. Sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies. Every state-changing request needs a custom header (CSRF protection).
- CalDAV passwords and Google/Microsoft refresh tokens are encrypted with AES-256-GCM at rest.
- Microsoft and Google tokens are only ever sent to Microsoft and Google. Phone subscribe links are long random tokens stored hashed; making a new link cuts off the old one.
- Display links are long random tokens stored hashed. They can only view calendars and lists marked for displays, tick chores, and (if allowed) edit events. They cannot change settings or sharing.
- Login and registration are rate-limited. The server refuses to fetch loopback and link-local addresses, and can refuse the whole LAN too (`BLOCK_PRIVATE_NETWORKS=true`).
- If the server is reachable from the internet, use HTTPS and keep `ALLOW_SIGNUP=false`.

## Local development

```bash
cd app
npm install
APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://user:pass@localhost:5432/hearth npm run dev
```

`npm run dev` restarts on file changes. Database migrations in `app/src/migrations` run automatically at startup. The front end has no build step: edit `app/public` and reload.

## Known limitations

- Linked calendars sync one year back and three years ahead by default.
- Outlook attendees and meeting invitations aren't shown or sent; Hearth edits the event on your own calendar only.
- Photos are stored in the database (up to 300), so they're included in backups; keep them reasonably sized.

## License

[MIT](LICENSE). Use it, change it, and share it freely.
