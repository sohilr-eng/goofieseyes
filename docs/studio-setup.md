# goofieseyes studio — setup (about an hour, once)

The studio is a small private web app at **studio.goofieseyes.live**. From your phone or laptop it
posts to Facebook, Instagram and Threads, either right away or at a scheduled time, and it keeps
working when your computer is off. The code is in `studio/` in this repo. On Vercel it is its own
project, separate from the website, so the token that can post (and later run ads) is never part of
the public site.

This is a **different Meta app** from the read-only "Shorts Desk" one. Leave that app alone.

**Never paste a token into chat or into a file.** Tokens go straight from Meta into Vercel's
environment variables (step 7).

---

## 1. Check the accounts are linked
Your existing Shorts Desk setup already covers this. For the record:
- goofieseyes on Instagram is a **professional** account (Creator or Business).
- It's linked to the **GoofiesEyes Facebook Page**.
- The Page belongs to your **business portfolio** in Meta Business Suite (Settings → Accounts → Pages).
- Threads: the goofieseyes Threads profile is the one tied to that Instagram account.

## 2. Create the Meta app
1. https://developers.facebook.com → **My Apps → Create app**.
2. Name it **goofieseyes studio**. When asked for a business portfolio, pick yours. That's required
   for the step 3 token.
3. Add these **use cases**. Exact wording changes; pick the closest match:
   - **Manage everything on your Page**
   - **Manage messaging & content on Instagram**: the version **with Facebook Login** (not "Instagram Login")
   - **Access the Threads API**
   - Phase 3 will add **Create & manage ads with Marketing API**. You can add it now.
4. App settings → Basic: fill in
   - **Privacy Policy URL:** `https://goofieseyes.live/privacy`
   - **User data deletion:** choose "Data deletion instructions URL" → `https://goofieseyes.live/privacy#delete`
   - an app icon (the lens mark works) and the category (Business).

## 3. Facebook + Instagram token (never expires)
Meta Business Suite → **Settings** (business settings) → **Users → System users**:
1. **Add** a system user named `studio` with the **Admin** role.
2. **Assign assets** to it:
   - Pages → GoofiesEyes → **Full control**
   - Instagram accounts → goofieseyes → **Full control**
   - Apps → goofieseyes studio → **Full control**
   - Ad accounts → yours, if one exists (phase 3; "not sure" is fine, the studio will show what it finds)
3. **Generate new token** → choose the **goofieseyes studio** app → expiry **Never** → tick all of these.
   Phases 2–4 need some of them, so ticking them now means no regenerating later:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`,
   `pages_read_user_content`, `pages_messaging`, `read_insights`, `business_management`,
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
   `instagram_manage_insights`, `instagram_manage_messages`,
   `ads_management`, `ads_read`, `catalog_management`, `leads_retrieval`
4. Keep that tab open. The token goes into Vercel in step 7 as `META_SYSTEM_USER_TOKEN`.

## 4. Threads token (lasts 60 days, then the studio renews it daily)
In the app dashboard → **Use cases → Access the Threads API → Customize**:
1. **Permissions:** add `threads_basic`, `threads_content_publish`, `threads_manage_insights`,
   `threads_read_replies`, `threads_manage_replies`.
2. **Settings:** set the redirect callback URL to `https://studio.goofieseyes.live/`. The
   uninstall/delete callback fields also want URLs; that same address is fine for both.
3. **App roles → Roles → Add people → Threads Tester** → your goofieseyes Threads username. Then in
   the **Threads app**: Settings → Account → Website permissions → Invites → **Accept**.
4. Back in the use case → **User Token Generator** → **Generate** next to goofieseyes, then approve.
   The result is a long-lived token, which goes into Vercel as `THREADS_ACCESS_TOKEN`.

## 5. Switch the Meta app to Live
App dashboard → top bar **App Mode: Development → Live**.

**Don't skip this.** While the app is in Development mode, its posts are visible only to people with a
role on the app. You'd see them; your followers wouldn't (Meta: "can only be seen by role users").

Standard access is enough here, because the studio only touches assets your own business owns. If
Meta ever rejects a permission after going Live, tell Claude: the fix is an App Review submission
describing it as an internal tool for your own accounts.

## 6. Vercel project + storage
1. Vercel → **Add New → Project** → import `sohilr-eng/goofieseyes` again (the same repo).
   - **Root Directory: `studio`**
   - Framework preset: **Other**. Leave the build settings empty.
   - Deploy. The first deploy works but shows "not configured" until step 7 is done.
2. Project → **Settings → Domains** → add `studio.goofieseyes.live`, then add the CNAME record it
   shows at your DNS provider.
3. Project → **Storage**:
   - **Create → Blob** → access **Public** → connect to this project. Instagram and Threads fetch
     the photos from these links. Each link is random and unguessable, and the file is deleted two
     days after it's posted.
   - **Marketplace → Upstash → Redis** (free plan) → connect to this project.
   - **Marketplace → Upstash → QStash** (free plan, 1,000 messages a day) → connect to this project.

   Connecting each one adds its environment variables automatically.

## 7. Environment variables
Project → **Settings → Environment Variables** (Production). Mark the token ones **Sensitive**.

| Name | Value |
|---|---|
| `STUDIO_PASSWORD` | the password you'll sign in with (long; a passphrase is good) |
| `SESSION_SECRET` | a random string; run the command below in a terminal and paste the output |
| `CRON_SECRET` | another random string from the same command |
| `STUDIO_URL` | `https://studio.goofieseyes.live` |
| `META_SYSTEM_USER_TOKEN` | the step 3 token |
| `THREADS_ACCESS_TOKEN` | the step 4 token |
| `FB_PAGE_ID` | leave unset unless the studio says the system user can see several Pages |

Random strings:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then **Deployments → ⋯ → Redeploy**. Environment variable changes only apply to new deployments.

## 8. Try it
1. On your phone, open `https://studio.goofieseyes.live` and sign in. Use the browser's Share menu →
   **Add to Home Screen** so it opens like an app.
2. **Connections** should show green dots for Facebook Page, Instagram, Threads, uploads, storage and
   scheduler.
3. Post something small "Now" to all three. The Queue shows each platform go **Live** with a View link.
   Threads takes about 30 seconds longer than the others, which is Meta's recommended wait.
4. Schedule one five minutes out, close the tab, and check that it goes out.

## How it behaves
- **Photos** are converted to JPEG in your browser (the only image format Instagram accepts) and
  capped at 2048px. Instagram also rejects anything taller than **4:5** or wider than **1.91:1**,
  and your 2:3 portraits are taller than that. Those get a warning, and you choose **Crop 4:5** or
  **Border 4:5** (white borders) on each one. The same file goes to all three platforms.
- **Video**: MP4 or MOV, up to 300 MB. On Instagram a single video becomes a Reel. Facebook can't mix
  photos and a video in one post.
- **Captions**: write one, or open "Different caption per platform". Threads allows 500 characters;
  Instagram allows 2,200 characters and 30 hashtags.
- **Scheduling**: QStash's free plan only holds messages up to about 7 days ahead. Posts further
  out are saved, and the daily 9:00 UTC cron queues them once they're within 6 days.
- **Failures**: Meta's temporary errors are retried automatically, up to 6 times. A real error
  (for example a bad file) fails that platform only, and the Queue offers **Retry failed**.
- **Removing** a post from the Queue never deletes it from Facebook, Instagram or Threads.

## If something goes wrong
- **"STUDIO_PASSWORD and SESSION_SECRET must be set"** → step 7, then redeploy.
- **"The system user has no Pages assigned"** → step 3.2.
- **"No Instagram account is linked to the Page"** → step 1.
- **Facebook works but followers can't see posts** → step 5 (the app is still in Development mode).
- **Threads "not refreshed" in the daily cron log on day one** → normal. Meta only allows a refresh
  once a token is 24 hours old.
- **Threads token expired** (the app was unused for over 60 days and the cron failed): redo step 4.4,
  then replace `THREADS_ACCESS_TOKEN` and redeploy.

## Working on it locally
```bash
cd studio && npm install && npm test
```
Run `npm run dev` (http://localhost:3100, password `dev`) and set `STUDIO_FAKE_META=1` to simulate
Facebook, Instagram and Threads, so nothing real gets posted.
