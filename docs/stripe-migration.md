# Stripe migration — moving prints to the goofiesfotos@gmail.com account

Target account: the new Stripe account registered to **goofiesfotos@gmail.com**.
Products in scope: **Payments** (prints store), **Invoicing** (client work), **Tax**.

| | Account ID | Login | Role |
| --- | --- | --- | --- |
| Old | `acct_1THQd3IfDaiKBGuM` ("Soriansystems") | sohil.r@outlook.com | What the live site charges through today. Checkout shows "soriansyst", card statements say `SORIANSYSTEMS.COM`. |
| New | `acct_1UHptvRG7SXRCoBF` ("Sorian Systems LLC") | goofiesfotos@gmail.com | Target. Statement descriptor already `GOOFIESEYES.LIVE`. |

State of the new account as read on 2026-09-20:

- Charges and payouts enabled, no outstanding verification requirements.
- **No bank account attached.** Add one (Settings → Payouts) before taking live money,
  or payouts have nowhere to go.
- Tax settings `active`, head office set (New Jersey). Step 3.1 below is done.
- **Zero tax registrations.** `automatic_tax` will collect nothing anywhere until one is added.
- **Preset tax code is Consulting Services** (`txcd_20060048`). The checkout code falls
  back to the preset when the tax code env vars are unset, so leaving them unset would tax
  prints and downloads as consulting. They are required on this account, not optional.
- Branding is Stripe's default: no logo, no icon, default colours.
- No Checkout Sessions yet.

The code changes are done and tested. What remains is account configuration,
which has to happen in the Dashboard, plus one cutover.

---

## Where the secrets live

Every secret is a **sensitive** Vercel environment variable on the goofieseyes
project (Settings → Environment Variables), Production only. Sensitive means
write-only: no one can read a value back, including you. That is intended.
There is no copy anywhere else, so a lost or leaked secret is **replaced**, never
recovered.

| Variable | What it is | Where a new one comes from |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Restricted key (`rk_live_…`) on the new account | Stripe → Developers → API keys → Create restricted key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) for the webhook endpoint | Stripe → Developers → Webhooks → the endpoint → Signing secret (roll it to get a new one) |
| `RESEND_API_KEY` | Resend API key, shared with the contact form | resend.com → API Keys |

To replace one, copy the new value, then in PowerShell from the repo folder:

```powershell
vercel env add STRIPE_SECRET_KEY production --sensitive --force --value (Get-Clipboard -Raw).Trim()
```

```powershell
Set-Clipboard -Value $null
```

Use `--value (Get-Clipboard -Raw).Trim()`, not `Get-Clipboard | vercel env add`.
Piping skips the CLI's confirmation prompts and stores the line break PowerShell
appends, so Stripe rejects the key. Then redeploy (any push to master), because
running deployments keep the value they were built with. Finally, delete the old
key in Stripe.

To check a variable really is sensitive, don't trust `vercel env ls`: its table
prints "Encrypted" for every hidden variable, sensitive or not. The JSON output
carries the real `type`:

```powershell
vercel env ls production --format json
```

## What does and does not carry over

| Thing | Carries over? | Notes |
| --- | --- | --- |
| Product catalog | **Nothing to move** | Prices are built inline from `content/data/prints.json` on each request. There are no Product or Price objects in the old account to migrate. |
| Past payments, payouts, customers | **No** | They stay in the old account. Keep it open, in read-only use, until you have filed taxes for every year it took money. |
| Tax registrations | **No** | Per-account. Must be set up fresh — see step 3. |
| API keys | **No** | New account, new keys — see step 2. |
| Webhook endpoints and signing secrets | **No** | New endpoint, new `whsec_` — see step 4. |

The inline-pricing design is what makes this migration cheap. Nothing in the
codebase references a Stripe object ID.

---

## Step 1 — Create a sandbox first

Do not develop against live mode. In the new account:

Dashboard → top-left account switcher → **Sandboxes** → create one for development.

A [sandbox](https://docs.stripe.com/sandboxes.md) isolates test data and
settings from live mode. Use its keys for everything up to the cutover.

## Step 2 — Create a restricted key, not a secret key

Use a [restricted API key](https://docs.stripe.com/keys.md#manage-your-api-keys)
(`rk_`), not `sk_`. If it leaks, the blast radius is whatever you granted it and
nothing else.

Dashboard → Developers → API keys → **Create restricted key**.

Permissions this integration actually needs:

| Resource | Permission | Why |
| --- | --- | --- |
| Checkout Sessions | **Write** | `create-checkout-session.js` creates them |
| Webhook Endpoints | **Read** | signature verification |
| Charges / PaymentIntents | **Read** | reading order state |

Nothing else. No Customers write, no Payouts, no Connect.

Set it on Vercel as a
[sensitive environment variable](https://vercel.com/docs/environment-variables/sensitive-environment-variables)
so the value is write-only and never shows in logs or the UI:

```bash
vercel env add STRIPE_SECRET_KEY production --sensitive
```

Repeat for `preview` using the sandbox key, so preview deploys can never touch
live money.

## Step 3 — Stripe Tax (do this before enabling anything live)

The code now sends `automatic_tax: { enabled: true }`. **That alone collects
nothing.** Stripe Tax only collects in jurisdictions where you hold an active
registration, and it does not raise an error when you have none — it silently
charges zero tax while the integration looks configured. This is the single most
common Stripe Tax mistake.

1. **Set a head office address.** Dashboard → Tax → Settings. Until this is set,
   the settings `status` is `pending` and `automatic_tax` calculates nothing.
2. **Add a registration** for every jurisdiction where you are obligated to
   collect — [Tax → Registrations](https://docs.stripe.com/tax/registering.md).
   Which jurisdictions those are is a question for your accountant, not for
   Stripe and not for me. For US remote sellers Stripe offers "Register for me".
3. **Turn on threshold monitoring.** Tax → Locations → "Needs attention" tells
   you when sales cross a nexus threshold somewhere new.
4. **Pick product tax codes.** A physical fine art print and a digital download
   are taxed differently in most US states, so they need different codes. Get
   the exact values from the
   [tax code guide](https://docs.stripe.com/tax/tax-codes.md) or the
   [Tax Codes API](https://docs.stripe.com/api/tax_codes.md) — do not copy a
   `txcd_` from a blog post, and do not default to the generic
   "Electronically Supplied Services" code for US digital sales, which is too
   broad for state-level taxability.

   Candidates, each confirmed to exist in the Tax Codes API on 2026-09-20.
   Choosing one is a classification decision for you and your accountant:

   | For | Code | Stripe's name |
   | --- | --- | --- |
   | Digital downloads | `txcd_10505001` | Digital Finished Artwork - downloaded - non subscription - with permanent rights. Its description names photographs explicitly. |
   | Physical prints | `txcd_99999999` | General - Tangible Goods. Stripe's docs point here for most physical goods; the [physical goods filter](https://docs.stripe.com/tax/tax-codes?type=physical) has narrower codes if one fits better. |
   | Client invoices | `txcd_20060048` | Consulting Services, which is already the account preset. Worth checking whether it describes creative direction and filming work, or whether a closer services code exists. |

   Then set:

   ```bash
   vercel env add STRIPE_PRINT_TAX_CODE production
   vercel env add STRIPE_DIGITAL_TAX_CODE production
   ```

   Left unset, both fall back to the account preset tax code. The code never
   guesses a value.
5. **Verify before trusting it.** In the sandbox, run a test transaction with a
   buyer address in a jurisdiction you registered, then retrieve the session
   with `expand[]=line_items.data.taxes` and read `taxability_reason`. If it
   says `not_collecting`, the setup is broken — either no registration there, or
   a Nontaxable product tax code. Any other value means calculation worked, even
   when the tax is zero.

Prices are sent as `tax_behavior: 'exclusive'`, so tax is added on top of the
listed price rather than carved out of it. If you ever advertise prices tax-in,
change that to `inclusive` in `api/create-checkout-session.js`.

## Step 4 — Webhook endpoint

`api/stripe-webhook.js` is new and it is the only place an order is fulfilled.
Before it existed, a digital buyer who closed the tab after paying got nothing —
the success page promises the file is "on its way to your email" and nothing was
sending it.

1. Dashboard → Developers → Webhooks → **Add endpoint**
2. URL: `https://goofieseyes.live/api/stripe-webhook`
3. Events to send:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
4. Copy the signing secret (`whsec_…`) and set it:

   ```bash
   vercel env add STRIPE_WEBHOOK_SECRET production --sensitive
   ```

Test it locally before cutover with the Stripe CLI (`npm i -g @stripe/cli`):

```bash
stripe listen --forward-to localhost:3000/api/stripe-webhook
```

```bash
stripe trigger checkout.session.completed
```

## Step 5 — Digital delivery (sent by hand)

Decided 2026-09-21: digital files are emailed **by hand**, within 24 hours. The
site only holds the 1200px web copies the admin portal makes on upload
(`admin/server.js`, sharp resize), not the originals a buyer is paying $20–25
for, and prints are not the main line of business yet.

How an order runs:

1. The buyer gets a confirmation promising the file within 24 hours. Replies go
   to goofiesfotos@gmail.com, because `orders@goofieseyes.live` has no inbox.
2. You get an email titled **"Send file: <photo> — new digital order"** naming
   the file. **Reply to it with the original attached.** The reply goes
   straight to the buyer.

The checkout line item, the checkout summary ("Email · within 24 hours") and
the success page all say 24 hours, not instant.

If this becomes a chore, the automatic version is: upload originals to private
storage (Supabase Storage, which is already connected) and email an expiring
signed link from `confirmDigital()` in `api/stripe-webhook.js`.

**The email sender has to be verified, or no email goes out at all.** Both
the webhook and the contact form fall back to `onboarding@resend.dev`, Resend's
test sender, which only delivers to the Resend account owner — and the Resend
account belongs to sohil.r@outlook.com, so even owner notices to
goofiesfotos@gmail.com are refused. Verify `goofieseyes.live` as a sending
domain in Resend. Its DNS records (DKIM, plus MX and SPF on `send.`) were live
on 2026-09-21. `PRESSING_FROM` is set to
`GoofiesEyes <orders@goofieseyes.live>`.

Setting a value containing `<` or `>` from Git Bash with `--value` hangs,
because Windows' `vercel.cmd` wrapper reads them as redirection. Pipe it in
instead: `printf '%s' 'GoofiesEyes <orders@goofieseyes.live>' | vercel env add PRESSING_FROM production --force`.

The webhook returns
500 when Resend refuses a message, so Stripe retries for up to three days, and
the failures show up under the endpoint in the Stripe Dashboard. They are no
longer silent, but an order still won't go through until this is set.

## Step 6 — Cutover

1. Deploy with sandbox keys on a preview URL. Buy one digital print and one
   physical print with test card `4242 4242 4242 4242`.
2. Confirm: buyer download email arrives, owner notification arrives, tax line is
   what your accountant expects, webhook shows 200 in the Dashboard.
3. Swap production env vars to the **live** restricted key and the **live**
   webhook signing secret.
4. Run one real low-value purchase end to end. Refund it.
5. Leave the old account's keys revoked but the account open until its final tax
   year is filed.

Work through the [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live.md)
before step 4.

---

## Invoicing — for the client side of the business

The prints store is self-serve checkout. Creative direction and cinematic
storytelling work is not: it is quoted, scheduled, and billed per engagement.
That is [Invoicing](https://docs.stripe.com/invoicing.md), and for the volume a
single operator has, **it needs no code at all** — build invoices in the
Dashboard, or from a saved template.

What to set up once:

- **Branding** — Dashboard → Settings → Branding. Logo, the site's colours, so
  an invoice looks like it came from GoofiesEyes and not from a generic tool.
- **Automatic tax on invoices** — toggle it per invoice; it uses the same
  registrations from step 3.
- **Payment terms and reminders** — Settings → Invoicing. Automatic reminders at
  3 days before due, on the due date, and 7 days after collect most late
  invoices without you writing an email.
- **Deposits** — for shoot work, a common structure is a deposit invoice to hold
  the date and a balance invoice on delivery. Two invoices, not one.

Only reach for the [Invoicing API](https://docs.stripe.com/api/invoices.md) if
you later want the "request a pressing" form on the landing page to generate a
draft invoice automatically. That is a real option — `api/request-pressing.js`
already captures name, email, and project details — but it is not worth building
until the manual version is a chore.

Do not use the prints `automatic_tax` setup as evidence invoicing is tax-ready:
invoices need the customer to have a saved address, which the prints flow gets
from Checkout instead.

---

## Known gaps, deliberately left

These are real and worth knowing about; none block the migration.

- **Webhook idempotency.** Stripe retries on any non-2xx, and a retry after a
  partial failure can send a second email. Harmless at current volume; fix by
  recording handled `event.id`s (a Supabase table, or Vercel KV) and returning
  early on a repeat.
- **No shipping cost.** The flow collects a shipping address for six countries
  but charges nothing to ship to any of them, including internationally. Add
  [shipping rates](https://docs.stripe.com/payments/during-payment/charge-shipping.md)
  to the session, or fold the cost into the print price.
- **No order record.** Orders exist only as Stripe sessions and emails. If you
  want a fulfilment queue, write the order to Supabase from the webhook.
- **No Content-Security-Policy header.** `vercel.json` sets caching headers only.
  Worth adding, per the
  [integration security guide](https://docs.stripe.com/security/guide.md).
- **`playwright` is undeclared.** It sits in `node_modules` but not in
  `package.json`, so any `npm install` prunes it and the scroll-scrub bench
  scripts stop working until it is reinstalled. Declaring it as a devDependency
  would settle this.
