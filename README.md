# Recruitment portal

A self-hosted careers site for your company. Candidates browse open jobs and apply online: they answer your questions, upload a CV (and optionally a cover letter) and list referees. You review everything in a private dashboard and can send referees a secure one-time link to submit a reference.

It is built so that applicants' personal information stays private:

- **Everything personal is encrypted at rest.** Names, contact details, answers, referee details, references, your notes, CVs and file names are all encrypted with AES-256-GCM before they are written to disk. A copy of the database or the uploads folder is useless without the key.
- **Only signed-in admins can see applications.** Signing in needs a password and a code from an authenticator app. There is no public sign-up.
- **Every access is logged.** Sign-ins and every view, download, change or deletion of applicant data are recorded.
- **Data is deleted automatically** after a retention period you choose (180 days by default).

---

## Quick start (on your computer)

You need [Node.js](https://nodejs.org) 22.13 or newer. There is nothing to compile: the app uses Node's built-in SQLite and scrypt, so it also installs on shared hosting.

```bash
npm install
cp .env.example .env
npm run generate-key          # copy the printed DATA_ENCRYPTION_KEY=... line into .env
```

For a local trial, edit `.env` and set `NODE_ENV=development` and `PUBLIC_BASE_URL=http://localhost:3000`. Then:

```bash
npm run create-admin          # choose a username and password, then add the key to your authenticator app
npm start
```

- Careers site: http://localhost:3000
- Dashboard: http://localhost:3000/admin

In the dashboard, open **Jobs → New job**, add a title, description and any questions, and set how many referees are required. When the job is open it appears on the careers page.

## Everyday use

| Task | Where |
| --- | --- |
| Post, edit or close a job | Jobs |
| Review applicants, download CVs, set status, keep private notes | Applications → click a row |
| Ask for a reference | Open an application → under a referee, **Email reference request** (if email is set up) or **Create reference link** and send the link yourself |
| Cancel a reference link | **Cancel link** next to a pending request |
| Delete an applicant's data (e.g. if they ask) | Open the application → **Delete application permanently** |
| See who accessed what | Activity |
| Change your password | Account |

The first admin account can be created in the browser at `/setup` when the `SETUP_CODE` setting is present. That page switches itself off once an admin exists. Add more admins, or reset a lost password or authenticator, by running `npm run create-admin` on the server.

## Deploying

- **On a subdomain of your website (e.g. `careers.yourcompany.com`), with no server to manage:** follow [HOSTING.md](HOSTING.md). It runs the portal on Render, straight from this GitHub repository (`render.yaml` is ready), and points the subdomain at it from your domain company (written for one.com). Everything, including creating your admin account, is done in the browser.
- **On cPanel/Plesk shared hosting that has "Setup Node.js App":** follow [docs/hosting-cpanel.md](docs/hosting-cpanel.md).

Whichever way you host it, the portal must be served over **HTTPS**; it refuses to start in production with an `http://` address. On your own server, two common setups:

**A. A small Linux server (VPS) with Caddy** (Caddy gets HTTPS certificates automatically):

```bash
# on the server, in the project folder
npm ci --omit=dev
cp .env.example .env   # fill in DATA_ENCRYPTION_KEY, PUBLIC_BASE_URL, COMPANY_NAME, ...
npm run create-admin
npm start              # run it under systemd or pm2 so it restarts automatically
```

`/etc/caddy/Caddyfile`:

```
jobs.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Keep `HOST=127.0.0.1` so the app is only reachable through Caddy, and `TRUST_PROXY=1` so rate limiting sees visitors' real IP addresses.

**B. Docker** (behind any HTTPS proxy or platform):

```bash
docker build -t recruitment-portal .
docker run -d --name recruitment -p 127.0.0.1:3000:3000 \
  -v recruitment-data:/data --env-file .env -e HOST=0.0.0.0 \
  recruitment-portal
docker exec -it recruitment node scripts/create-admin.js
```

The database and encrypted uploads live in the `/data` volume. If you use a hosting platform, give it a **persistent disk** for `DATA_DIR`. Without one, applications disappear on every redeploy.

### Email (optional)

Set the `SMTP_*` variables (see `.env.example`) to:

- email referees their reference link directly from the dashboard;
- get a notification at `NOTIFY_EMAIL` when an application or reference arrives. These notifications contain only the job title and a reference number, never applicant details.

Without email, everything still works: you copy the reference link and send it yourself.

### Backups and the encryption key

- Back up the whole `DATA_DIR` folder (database + `uploads/`) regularly. The backup is encrypted, so it is safe to store off-site.
- Store `DATA_ENCRYPTION_KEY` **separately** from the backups, for example in a password manager. Anyone holding both the backup and the key can read the data. **If you lose the key, the data cannot be recovered.**

## How personal data is protected

### At rest
| What | How it is stored |
| --- | --- |
| Applicant details, answers, referees | One AES-256-GCM encrypted record per application |
| CVs and cover letters | Encrypted files with random names in `uploads/`, never inside the web folder |
| Original file names, admin notes, references, authenticator secrets | Encrypted |
| Admin passwords | Salted scrypt hashes (OWASP-recommended settings) |
| Session and reference-link tokens | SHA-256 hashes only, so a stolen database can't be used to sign in or open links |
| Repeat-applicant detection | Keyed HMAC of the email address, not the address itself |

Each encrypted value is bound to its own record, so ciphertext can't be swapped between rows. Deleted database rows are overwritten (`secure_delete`), and files and folders are created readable by the app's user only.

**Not encrypted:** job postings (they are public anyway), application status, dates and the audit log, which contains only IDs, never names.

### Who can see what
- **The public** sees only open jobs. Applicants receive a reference number, never anything back. The form never reveals whether an email address has applied before.
- **Referees** see only the candidate's name, the job title and your company name. They never see contact details, answers or the CV. Each link works once, expires (14 days by default) and can be cancelled. The token sits after the `#` in the link, so browsers never send it to the server, proxies or logs.
- **Admins** see everything after signing in with password + authenticator code.

### Admin sign-in
- Password + 6-digit authenticator code (TOTP). A used code can't be replayed.
- The account locks for 15 minutes after 5 failures, and each IP address is limited to 10 attempts per 15 minutes.
- Error messages and response times are the same for a wrong username, password or code.
- Sessions use an `HttpOnly`, `SameSite=Strict`, `Secure`, `__Host-` cookie and expire after 60 idle minutes or 8 hours. Every change requires a CSRF token.
- Changing your password signs out all your other devices.
- The optional first-run page `/setup` needs the `SETUP_CODE` that only your hosting dashboard shows. It creates the account only after a correct authenticator code, and switches off for good once an admin exists, so it can't be used to add accounts or take over the portal.

### Uploads
- Only PDF and Word `.docx` are accepted. The type is checked from the file's actual contents; the name and browser-reported type are ignored.
- PDFs containing JavaScript or launch actions and Word files with macros or ActiveX are rejected.
- Size is limited (5 MB by default) and the job is checked before the upload is read.
- Downloads always come as attachments with a sandboxing security policy, so a file can't run inside the dashboard. An integrity hash is checked before each download.

### Web security
- Strict Content-Security-Policy (no inline or third-party scripts), HSTS, `nosniff`, `no-referrer`, and no framing.
- All page content is inserted as text, never HTML, so a name like `<script>` displays harmlessly.
- Strict input validation: unknown fields are rejected, answers are checked against each question's type, and links must be `http(s)`.
- API responses are marked `no-store`, so personal data isn't kept in browser or proxy caches.
- Rate limits apply to applications, reference links and the API. A hidden "honeypot" field silently drops bot submissions.
- Logs record only method, path, status and timing: no query strings, bodies, IPs or personal data.

### Retention
An hourly job deletes applications (with their files and references) once they have had no activity for `RETENTION_DAYS`. It also clears expired sessions, expired reference links, audit entries older than a year, and any orphaned upload files. Applicants are told the retention period on the form.

## Your responsibilities

The software can't do these for you:

- **Keep the key and admin passwords safe.** Use a long unique password and turn on disk encryption on the server if your host offers it.
- **Keep the server updated.** Run `npm audit` and update dependencies from time to time.
- **Follow your data-protection law** (for example GDPR, or your country's equivalent). Adjust the privacy wording on the application form if needed, and set `PRIVACY_CONTACT_EMAIL` so applicants know who to ask for access to, correction of, or deletion of their data.
- **Be careful with CVs.** Uploads are screened, but treat documents from strangers with normal caution and keep your computer's software up to date.

Known limitations: the encryption key can't yet be rotated without a migration script, and rate limits are kept in memory, so they reset on restart and assume a single server instance.

## Development

```bash
npm test     # 63 tests covering access control, encryption at rest, uploads, CSRF, sessions, references, retention
npm run dev  # restarts on file changes
```

Project layout:

```
src/
  server.js          start-up, hourly maintenance, graceful shutdown
  app.js             Express app, security headers, error handling
  config.js          environment variables, with checks that fail fast
  crypto.js          AES-256-GCM encryption, keyed hashing, tokens
  db.js              SQLite schema and migrations
  files.js           upload inspection and encrypted file storage
  maintenance.js     retention and clean-up
  routes/public.js   job listings and applications
  routes/references.js  referee lookup and submission
  routes/admin.js    dashboard API
  routes/setup.js    one-time browser setup of the first admin
  security/          passwords, sessions, TOTP, auth/CSRF/rate-limit middleware
public/              careers site, application form, referee form, dashboard (plain HTML/CSS/JS)
scripts/             generate-key, create-admin
render.yaml          Render Blueprint (see HOSTING.md)
test/                automated tests
```
