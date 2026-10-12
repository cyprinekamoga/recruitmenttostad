# Putting the portal online at careers.yourcompany.com

This guide is for a domain and website hosted at **one.com**, but the steps work with any domain company.

> Replace `yourcompany.com` with your real domain everywhere below.

## How it fits together

```
yourcompany.com           → your website, stays at one.com (nothing changes)
careers.yourcompany.com   → the recruitment portal, running on Render
GitHub                    → stores the portal's code; Render updates the site from it
```

**Why not one.com, or GitHub Pages?** Both can only show fixed pages. The portal is an application: it receives applications, stores CVs securely and runs your dashboard, so it needs a host that runs programs. one.com's standard web hosting doesn't, and GitHub Pages is public-only.

[Render](https://render.com) runs it directly from your GitHub repository. Expect about **US$7–8 a month**: the "Starter" service plus a small 1 GB disk. Check [Render's pricing](https://render.com/pricing) for current prices. The free plan is **not** suitable: it has no disk, so every application and CV would be wiped whenever it restarts.

**You'll need:** your GitHub login, a payment card, access to your one.com Control Panel, and your phone (for the sign-in app). About **30 minutes**, plus up to a few hours of waiting for the subdomain to start working.

---

## Part 1: Create the site on Render (about 10 minutes)

1. Go to **[render.com](https://render.com)** → **Get Started** → **GitHub**, and sign in with your GitHub account.
2. When GitHub asks which repositories Render may access, choose **Only select repositories**, pick **recruitmenttostad**, and click **Install / Authorize**.
3. In the Render dashboard, click **New +** → **Blueprint**, select the **recruitmenttostad** repository and click **Connect**. Render reads the settings already prepared in the `render.yaml` file.
4. Give the Blueprint a name (e.g. `careers`) and fill in the three values it asks for:

   | Setting | What to enter |
   | --- | --- |
   | `COMPANY_NAME` | Your company's name, as applicants should see it |
   | `PRIVACY_CONTACT_EMAIL` | The address applicants can write to about their data, e.g. `privacy@yourcompany.com` |
   | `PUBLIC_BASE_URL` | `https://careers.yourcompany.com` |

5. Click **Apply** (or **Deploy Blueprint**). Add your card when asked.
6. Open the new **recruitment-portal** service. After 3–5 minutes its status changes to **Live**. Near the top you'll see its Render address, like `https://recruitment-portal-xxxx.onrender.com`. Keep this page open.

## Part 2: Save the secret key (2 minutes, important)

Render created two random secrets for you. Open the service's **Environment** tab:

- **`DATA_ENCRYPTION_KEY`**: reveal it and copy it into a password manager or another safe place. This key encrypts all applicant data. **If it is lost, the data can never be read again.** Never send it by email or chat.
- **`SETUP_CODE`**: you need this in Part 3.

## Part 3: Create your admin account (5 minutes, all in the browser)

1. Open `https://recruitment-portal-xxxx.onrender.com/setup` (your Render address with `/setup` on the end).
2. Paste the **SETUP_CODE**, choose a username and a password (at least 12 characters; a few random words work well, e.g. `lamp river orange pocket`), and click **Next**.
3. On your phone, install **Google Authenticator** or **Microsoft Authenticator** if you don't have one. In the app, tap **+** and **scan the QR code** on the screen.
4. Type the 6-digit code the app shows and click **Finish setup**.

You're now in the dashboard. The setup page switches itself off for good once your account exists.

From now on you sign in at `/admin` with your **username + password + the code from your phone**.

## Part 4: Connect careers.yourcompany.com (10 minutes + waiting)

**In Render:**

1. Open the service → **Settings** → **Custom Domains** → **+ Add Custom Domain**.
2. Enter `careers.yourcompany.com` and save. Render then shows what to point it to: a **CNAME** with a value like `recruitment-portal-xxxx.onrender.com`. Copy that value.

**In one.com** ([one.com's own guide](https://help.one.com/hc/en-us/articles/360000803517-How-do-I-create-a-CNAME-record)):

3. Log in to the **one.com Control Panel** and, if you have more than one, choose your domain.
4. Click the **Advanced settings** tile → **DNS settings** → **DNS records**.
5. Under *Create new record*, choose **CNAME** and enter:
   - **Hostname:** `careers`
   - **Is an alias of:** the value Render showed, e.g. `recruitment-portal-xxxx.onrender.com`
   - **TTL:** leave empty
6. Click **Create record**.

**Back in Render:**

7. Click **Verify** next to the domain. It can take from a few minutes to a few hours before it turns green. Render then sets up the secure padlock (HTTPS) automatically.
8. Open **https://careers.yourcompany.com**. 🎉

## Part 5: Final checks (5 minutes)

1. **Test the whole flow.** Sign in at `https://careers.yourcompany.com/admin` → **Jobs** → **New job**, and create a test job. In a private/incognito window, apply to it with any PDF. Check that the application shows up in the dashboard and the CV downloads, then delete both.
2. **Check the security setting for visitor addresses.** Open **Activity** in the dashboard and look at the *IP address* of your own sign-in. Then search the web for "what is my IP".
   - If they match, everything is set correctly.
   - If the dashboard shows something like `10.x.x.x`, tell me, so I can adjust the setting that tells applicants apart.
3. **Safety check:** `https://careers.yourcompany.com/.env` must show "Page not found".
4. **Link it from your website.** In your one.com website editor (or WordPress menu), add a **Careers** menu item linking to `https://careers.yourcompany.com`. Each job also has its own link (under **Jobs** in the dashboard) that you can share on social media or job boards.

---

## Optional: email

This lets you send reference requests straight from the dashboard and get a notification when someone applies. Create a mailbox like `careers@yourcompany.com` in one.com. Then in Render → **Environment** → **Add Environment Variable**, add:

| Key | Value |
| --- | --- |
| `SMTP_HOST` | `send.one.com` |
| `SMTP_PORT` | `465` |
| `SMTP_SECURE` | `true` |
| `SMTP_USER` | `careers@yourcompany.com` |
| `SMTP_PASS` | that mailbox's password |
| `MAIL_FROM` | `Your Company Careers <careers@yourcompany.com>` |
| `NOTIFY_EMAIL` | where you want new-application alerts, e.g. your own address |

Click **Save Changes**; Render restarts the site by itself. Alert emails never contain applicant details, only that something new is waiting in the dashboard. Without email, everything still works: you copy each reference link and send it yourself.

## Everyday running

- **Updates:** when the code on GitHub changes, Render rebuilds the site automatically, and the data on its disk is kept. Expect a few seconds of downtime during each update.
- **Backups:** the data lives on the service's **Disk** (see the *Disks* section of the service for snapshots). Its contents are encrypted, so a copy on its own reveals nothing. Keep `DATA_ENCRYPTION_KEY` safe and separate.
- **Who can see the data:** the encryption protects the data if the disk or a backup is copied. Because the key is stored in Render's settings, it doesn't hide the data from Render itself. The same is true at any hosting company. The data is stored in Render's **Frankfurt (EU)** region.
- **Don't delete the Render service:** deleting it deletes the disk and every application with it.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Deploy fails or the service won't start | Open the service's **Logs** tab: the app writes a plain-English explanation of what's wrong. Send it to me if it isn't clear. |
| `PUBLIC_BASE_URL must use https://` | In **Environment**, make sure the value starts with `https://`. |
| The setup page says "Browser setup is off" | `SETUP_CODE` is missing from **Environment**. Add one with a long random value, save, and reload. |
| "Sign-in failed" with the right password | Make sure your phone sets its clock automatically; the codes depend on the time. After 5 failed attempts, wait 15 minutes. |
| Lost your phone | In Render, open the service's **Shell** tab and run `npm run create-admin` with your username. It resets your password and gives you a new code for your new phone. |
| `careers.yourcompany.com` doesn't open yet | DNS changes can take a few hours. Double-check the CNAME in one.com: hostname `careers`, pointing to the exact value Render showed. |
| Applicants see "Too many requests" | Tell me: the visitor-address setting needs adjusting (see Part 5, step 2). |

## Other ways to host

- Shared hosting with a "Setup Node.js App" tool (cPanel, Plesk): see [docs/hosting-cpanel.md](docs/hosting-cpanel.md).
- Your own Linux server or Docker: see "Deploying" in the [README](README.md).
