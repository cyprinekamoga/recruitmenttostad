# Hosting on a subdomain of your website

This guide puts the recruitment portal at an address like **`https://careers.yourcompany.com`**, on the same web hosting account as your main website. Your main site isn't touched. Afterwards you just add a "Careers" link to it.

> Replace `yourcompany.com` with your domain, and `USER` with your hosting account's username, everywhere below.

**Time needed:** about 30–45 minutes.

---

## 0. Check that your host can run it

Log in to your hosting control panel (usually **cPanel**) and look under **Software** for **Setup Node.js App**.

- **It's there:** continue with this guide.
- **It's not there:** your plan can't run this kind of app. Many WordPress-only hosts, website builders (Wix, Squarespace) and the cheapest shared plans can't. You can still use a subdomain: run the portal on a small server or platform and point `careers.yourcompany.com` at it (see [the end of this guide](#if-your-host-cant-run-nodejs)).

When you create the app in step 4, the Node.js version list must include **22** (22.13 or newer). If the highest is 20 or lower, ask your host to enable Node.js 22.

You also need the **Terminal** (cPanel → Advanced → Terminal) or SSH access, to run two short commands. If you don't have it, ask your host to enable it.

## 1. Create the subdomain

cPanel → **Domains** → **Domains** → **Create A New Domain**
(older cPanel: **Subdomains**)

- Domain: `careers.yourcompany.com`
- **Untick "Share document root"** so it gets its own folder, e.g. `/home/USER/careers.yourcompany.com`
- Click **Submit**

**If your domain's DNS is managed somewhere else** (Cloudflare, your registrar, etc.), add a DNS record there:

| Type | Name | Value |
| --- | --- | --- |
| A | `careers` | your hosting account's IP address (cPanel home page → *General Information* → *Shared IP Address*) |

On Cloudflare, set the SSL/TLS mode to **Full (strict)**.

## 2. Turn on HTTPS for the subdomain

cPanel → **Security** → **SSL/TLS Status** → tick `careers.yourcompany.com` → **Run AutoSSL**.

Wait until it shows a valid certificate (a green padlock). This can take a few minutes, longer if you just changed DNS. **The portal will not start without HTTPS:** applicant data must never be sent unencrypted.

## 3. Upload the app (outside `public_html`!)

The app folder will hold the secret key and the applicants' data, so it must **not** be inside `public_html` or the subdomain's folder. Put it here:

```
/home/USER/recruitment          ← the app (create this folder)
/home/USER/public_html          ← your main website (leave alone)
/home/USER/careers.yourcompany.com   ← the subdomain's folder (leave empty)
```

The app refuses to start if it finds itself inside `public_html`.

**Option A, from GitHub (easiest to update later):** cPanel → **Files** → **Git™ Version Control** → **Create**
- Clone URL: your repository's URL. For a private repository, cPanel first needs an SSH key added to GitHub as a *deploy key*; if that's a hassle, use Option B.
- Repository Path: `recruitment`

**Option B, upload a zip:** on GitHub, click **Code → Download ZIP**. In cPanel → **File Manager**, create the folder `recruitment` in your home folder (not in `public_html`), upload the zip there, then **Extract** it. Make sure files like `package.json` and the `src` folder end up directly inside `recruitment`, not in a sub-folder.

## 4. Create the Node.js application

cPanel → **Software** → **Setup Node.js App** → **Create Application**

| Setting | Value |
| --- | --- |
| Node.js version | **22.x** (22.13 or newer) |
| Application mode | **Production** |
| Application root | `recruitment` |
| Application URL | `careers.yourcompany.com` |
| Application startup file | `src/server.js` |

Click **Create**. Then, on the same page, click **Run NPM Install** and wait for it to finish.

The app will show an error page for now. That's expected until it is configured in the next step.

## 5. Configure it (secret key and settings)

At the top of the Setup Node.js App page there is a command starting with `source /home/USER/nodevenv/...`. Copy it. Open cPanel → **Terminal**, paste it, and press Enter. Then run:

```bash
cp .env.example .env
chmod 600 .env
npm run generate-key
```

The last command prints a line like `DATA_ENCRYPTION_KEY=AbC123...`. **Save this line in your password manager now.** If it is ever lost, the stored applications can't be recovered.

Now open `/home/USER/recruitment/.env` in cPanel **File Manager** (right-click → **Edit**; turn on *Settings → Show Hidden Files* if you can't see it) and set:

```ini
DATA_ENCRYPTION_KEY=AbC123...
PUBLIC_BASE_URL=https://careers.yourcompany.com
NODE_ENV=production
COMPANY_NAME=Your Company Ltd
PRIVACY_CONTACT_EMAIL=privacy@yourcompany.com
TRUST_PROXY=1
```

Leave the other settings as they are. `PORT` and `HOST` are overridden by cPanel automatically. Save the file.

> Alternatively, enter these values as **Environment variables** on the Setup Node.js App page. Either way works; don't do both with different values.

## 6. Create your admin account

In the same Terminal window:

```bash
npm run create-admin
```

Choose a username and a long password (at least 12 characters; a few random words work well). It then shows a **setup key**. On your phone, open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …), choose **Add account → Enter a setup key**, and type it in. Then type `clear` to wipe the key from the screen.

## 7. Start it and test

On the Setup Node.js App page, click **Restart**. Then:

1. Open **https://careers.yourcompany.com**. You should see the careers page ("no open positions" for now).
2. Open **https://careers.yourcompany.com/admin** and sign in with your username, password and the 6-digit code from your phone.
3. Go to **Jobs → New job**, create a test job, and make sure it is open.
4. In a private/incognito window, apply to it with a test PDF.
5. Back in the dashboard, check that the application appears and the CV downloads. Then delete the test application and the test job.
6. **Safety check:** visit `https://careers.yourcompany.com/.env` and `https://careers.yourcompany.com/data/recruitment.db`. Both must show "Page not found".

## 8. Link it from your main website

Add a **Careers** (or "Work with us") link in your main website's menu pointing to `https://careers.yourcompany.com`.

Each job also has its own link (shown under **Jobs** in the dashboard) that you can share on social media or job boards.

---

## Optional: email

Email lets you send reference requests straight from the dashboard and get a notification when someone applies. Create a mailbox like `careers@yourcompany.com` in cPanel → **Email Accounts**, then add to `.env`:

```ini
SMTP_HOST=mail.yourcompany.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=careers@yourcompany.com
SMTP_PASS=the-mailbox-password
MAIL_FROM="Your Company Careers <careers@yourcompany.com>"
NOTIFY_EMAIL=you@yourcompany.com
```

Restart the app afterwards. Notification emails never contain applicant details, only that something new is waiting in the dashboard.

## Backups

- Your host's normal account backups include the `recruitment/data` folder. Its contents are encrypted, so a backup on its own reveals nothing.
- Keep the `DATA_ENCRYPTION_KEY` line in your password manager, **not** in the same place as backups.
- To keep your own copy: File Manager → `recruitment` → right-click `data` → **Compress**, then download the zip. Delete the zip from the server afterwards.

## Updating the app later

- **Git:** cPanel → Git Version Control → **Manage** → **Pull or Deploy** → **Update from Remote**.
- **Zip:** upload the new files over the old ones. Never delete `.env` or the `data` folder.

Then click **Run NPM Install** and **Restart** on the Setup Node.js App page.

## Troubleshooting

Error messages are written to `stderr.log` in the `recruitment` folder (open it with File Manager).

| Message or symptom | What to do |
| --- | --- |
| `Refusing to start: ... inside your website's public folder` | The app is inside `public_html`. Move the folder to `/home/USER/recruitment` and update **Application root**. |
| `PUBLIC_BASE_URL must use https://` | Use `https://` in `.env`, and make sure step 2 (AutoSSL) succeeded. |
| `DATA_ENCRYPTION_KEY is not set` | `.env` is missing or not in the `recruitment` folder; repeat step 5. |
| `Node.js 22.13 or newer is required` | Choose Node.js 22 on the Setup Node.js App page, then **Run NPM Install** and **Restart**. |
| `ExperimentalWarning: SQLite is an experimental feature` | Harmless. This is Node.js's built-in database, which the app uses so that nothing needs compiling on your host. |
| Everyone gets "Too many requests" at once | Make sure `TRUST_PROXY=1` is in `.env`, then restart. |
| "Sign-in failed" with the right password | Check your phone's clock is set automatically; the 6-digit codes depend on the time. After 5 failures, wait 15 minutes. |
| Lost your phone or password | Run `npm run create-admin` again in Terminal with the same username to reset both. |

## Other control panels

- **Plesk:** Websites & Domains → **Add Subdomain** → open it → **Node.js**. Set *Application Root* to the app folder, *Document Root* to its `public` folder, *Application Startup File* to `src/server.js`, and *Application Mode* to production. Click **NPM install**, create `.env` as in step 5, then **Restart App**. Enable **Let's Encrypt** for the subdomain.
- **DirectAdmin:** if your host offers **Setup Node.js App**, the steps match the cPanel ones above.
- **Hostinger (hPanel) and others:** look for a *Node.js* section. Its fields have similar names. The essentials are always: Node.js 22, startup file `src/server.js`, app folder outside the public web folder, HTTPS on, and the `.env` settings from step 5.

## If your host can't run Node.js

You can still use `careers.yourcompany.com`. Run the portal elsewhere and point the subdomain at it with one DNS record:

- **A small Linux server** (e.g. DigitalOcean or Hetzner, ~$5/month): follow "Deploying → A" in the README, then add an **A** record `careers` → the server's IP address.
- **A managed platform** such as Render: deploy the repository with a persistent disk for `DATA_DIR`, add `careers.yourcompany.com` as a custom domain in the platform, then add the **CNAME** record it gives you.
