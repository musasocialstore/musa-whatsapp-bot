# Musa WhatsApp Bot Platform — REAL platform code (not a design preview)

A multi-business WhatsApp bot platform for Musa Social Store (Zaib).
A business links **its own WhatsApp by pairing code, inside this
website, in real time** (Baileys `requestPairingCode()` — the code is
generated live by WhatsApp, never invented by this site), sets a prompt
+ uploads images / voice / videos, and the bot replies to that
business's customers — short, friendly, no pressure — and forwards
confirmed leads by **email + WhatsApp** to the owner.

**Zero dummy data.** No sample leads, no sample stats, no sample
media, no pre-filled numbers or names. Every page starts empty:
"WhatsApp not linked yet", "No media yet", "No leads yet". The user
adds their own real number, prompt, media, email and WhatsApp number.
The earlier design preview (a static dashboard mockup with "Sample
Data" on it) is NOT this code — this is the real Node.js server.

## Dashboard — 5 sections, in order

Open the dashboard at `http://localhost:3000/` after `npm start`.

1. **WhatsApp Connect** — enter your own WhatsApp number, click
   **Generate pairing code**. The server calls Baileys
   `requestPairingCode()` for that number in real time and shows the
   real code, big, with a 60-second countdown. If Baileys fails, the
   real error is shown and NO code is shown. Status badge shows
   **LINKED** (green), **WAITING** (amber, while the code is live) or
   **NOT LINKED** (red), polling every 15 seconds, with a Refresh
   status button and a Disconnect button. Instructions: phone —
   WhatsApp > Linked Devices > Link a device > Link with phone
   number, then enter the code within 60 seconds. (Zaib's number is
   never used for another business, and Muse is never paired — the
   business pairs with this website itself.)
2. **Business Prompt / Plan** — large text box for the business prompt
   / plan (who you are, what you sell, prices). Save button, and the
   saved prompt is shown below it.
3. **Media Upload** — upload voice notes, videos, and images (max
   16 MB each). For each file you can add a caption and a note
   "ye media kab bhejein?" (e.g. "website design, price list") — the
   bot sends that media when a customer asks about it. The list shows
   name, type, preview (image / video / audio player), caption,
   use-for note, and a Delete button.
4. **Lead Notification Settings** — email field (where lead details go
   by email) + WhatsApp number field (where the lead alert goes by
   WhatsApp). Save button. An **Add a lead manually** form lets the
   owner save a real lead (name, number, address, what they want —
   all blank, all required except address). No test / dummy lead is
   ever created by the site.
5. **Leads** — list with name, number, address, what they want,
   date/time, status (NEW / CONFIRMED), and email / WhatsApp delivery
   state. **Mark confirmed** forwards the lead to the saved email
   (Resend) and the saved WhatsApp number (via the linked session).
   If a key or the link is missing, the lead is still marked
   confirmed and the exact reason is shown in the lead (forwardLog).
   Empty until a real lead exists: "No leads yet".

Rules built in: DMs only (never groups), one short reply per incoming
message, no mass messaging, no chasing one person, no invented
prices / dates / payment numbers.

## Mobile-first UI

The dashboard (`public/index.html` + `style.css` + `app.js`) is
mobile-first: single column, 16px inputs (no iOS zoom), minimum
48px touch targets, full-width buttons on phones, sticky section
nav, readable at 390px width. On desktop (≥960px) it widens to a
desktop layout with a sticky nav. No dummy data is shown at any
screen size.

1. Business opens the dashboard, enters its own WhatsApp number, clicks
   **Generate pairing code**.
2. On their phone: WhatsApp > Linked Devices > Link a device >
   Link with phone number, enter the code. Their WhatsApp links.
   (Zaib's number is never used for another business.)
3. Business fills in: business name, prompt, lead email,
   lead WhatsApp number, and uploads images / voice / videos.
4. Incoming customer DMs on the linked WhatsApp get a Gemini reply
   (short, medium length, Roman Urdu / English as the customer uses).
   Relevant uploaded media is sent when it fits.
5. When a customer is final / gives details, a lead is captured
   (name, number, address, what they want) and, on confirm, forwarded
   to BOTH the lead email (Resend) and the lead WhatsApp number
   (the business's own linked WhatsApp).

## How to write your business prompt — plain words, any language

The prompt is the ONLY thing the owner has to write. Write it the
way you would explain your business to a friend — in Roman Urdu,
Urdu, English, or mixed, in plain words. The AI analyses the WHOLE
prompt and understands: your business name, what you do, your
location, your rate list, your deals, and how to deal with each
type of customer. You do **not** need any special format.

Include these, in your own words:
1. **Business name** — "mera business KFC hai" / "business name: Musa Social Store"
2. **What you do** — "main website development karta hun, ads run karta hun" / "hum fast food bechte hain — burgers, pizza, deals"
3. **Location** — "hamari location Lahore, Main Bazar hai" / "address: ..."
4. **Rate list** — every price, in your own words: "Basic website Rs 1,500", "Zinger Burger Rs 850"
5. **Deals / offers** — "Deal 1: 2 Zinger + fries Rs 1,200", "Friday special 20% off"
6. **How to deal with customers** — "customer deal pooche to deal batao, phir order lo", "customer price pooche to price list bhejo", "agar customer Urdu bole to Urdu mein jawab do", "final price main khud confirm karunga"

### Example prompt — a KFC food business (copy the style, change the facts)

```
Mera business KFC hai, fast food restaurant hai.
Hamari location Lahore, Main Bazar, near Clock Tower hai.
Hum burgers, pizza, fries aur cold drinks bechte hain.
Rate list:
- Zinger Burger Rs 850
- Chicken Burger Rs 650
- Large Pizza Rs 1,800
- Fries Rs 350
- Cold Drink Rs 200
Deals:
- Deal 1: 2 Zinger Burger + 2 Fries + 2 Cold Drinks Rs 1,900
- Deal 2: Large Pizza + Cold Drink Rs 1,950
- Friday special: har deal par 10% off
Delivery: Lahore mein 45 minute mein delivery, delivery charges Rs 150.
Customer ko kaise deal karna hai: customer pehle salam kare to
friendly jawab do, phir poochho kya chahiye. Customer deal pooche to
deal batao aur deal ka banner bhej do. Customer price pooche to rate
list bhej do. Customer order kare to naam, address aur phone number
lo, phir order confirm karo. Customer Urdu bole to Urdu mein baat
karo, English bole to English mein. Final price aur delivery time
main khud confirm karunga, tum sirf guide karo.
```

Paste a prompt like that in the **Business Prompt / Plan** box on
the board and Save it. The AI reads the whole thing — name,
services, location, rates, deals, and your dealing rules — and
then talks to each customer from it. If a customer asks something
that is NOT in your prompt, the bot says so honestly and says the
owner will confirm — it never invents a price, a deal, or a
delivery promise.

## How the AI replies (src/ai.js) — and what happens without a key

The bot ALWAYS uses the business prompt saved on the board
(services, prices, rules) and ALWAYS replies in the SAME language
the customer used — Urdu script, Roman Urdu, English, or any other
language — switching instantly when the customer switches
(e.g. "Urdu please" → Roman Urdu reply).

**Friendly human tone, not a robot:** replies are short (1–3 short
sentences), warm and natural, like a friendly person chatting on
WhatsApp. The wording varies every time — the bot never starts
every reply with the same greeting and never sends the same canned
message twice in a row. It uses the customer's name when they give
it, asks ONE helpful question (which deal? which type? where to
deliver?), then waits. No stiff template lines like "Thank you for
your message. Please tell me what you need."

- **With `GEMINI_API_KEY` set:** Gemini generates a varied, natural
  reply from the saved prompt (temperature 0.8), uses the prompt's
  real services/prices/deals, and asks one relevant follow-up
  question.
- **Without a key (the case on 2026-11-20, which caused the "same
  reply every time" complaint):** the bot does NOT send the old
  hardcoded English sentence. It replies honestly, in the customer's
  own language, that the AI assistant is not connected yet — but it
  still talks like a friendly human and uses the REAL facts from
  the owner's prompt: it gives the actual rate list when the
  customer asks price, the actual deal when they ask about deals,
  and the actual location when they ask where you are. The wording
  varies by language and by what they asked (greeting / price /
  deal / delivery / location / language request). It never pretends
  to be the AI.
- **If Gemini fails** (bad key, quota, network): the same honest
  fallback is sent, in the customer's language, instead of no reply.

**Full AI replies need a Gemini key — Zaib's step:**
Google AI Studio, signed in as `musasocialstore000@gmail.com` →
Get API key → Create API key in a new project, name it
**"Musa WhatsApp Bot"** → paste it in `.env` (local) or in
Render's Environment Variables (deployed) as `GEMINI_API_KEY`.
Until then the bot takes messages honestly and saves leads, but
cannot give full AI answers.

## How media works — the bot understands what each file IS

Upload an image / voice note / video, add a **caption** and a
**"useFor"** note saying when to send it. The bot does not just
attach files — it understands what each file IS and decides when,
where and to which customer to send it, always with a short
written line saying what it is.

| What the file is | Write in caption / useFor | When the bot sends it |
|---|---|---|
| Logo | caption "Musa Social Store logo", useFor "logo, first greeting" | On a first greeting, so the customer knows who you are |
| Offer / deal banner | caption "Today's deal banner", useFor "deal, offer, discount, special" | When the customer asks about deals / offers / discounts |
| Price list / menu / rate plan | caption "Price list", useFor "price, rate list, menu" | When the customer asks price / menu / rate |
| Demo video / design sample | caption "Website demo", useFor "demo, show me, design" | When the customer asks to see it / "dikhao" |
| Intro voice / welcome | caption "Voice introduction", useFor "intro, welcome, voice" | On a first greeting, or when they ask to hear a voice note |
| Anything else | caption + useFor in the words customers actually use | Only on a clear word match — never at random |

How matching works (scored, never random, never always): exact
useFor phrase +10, each useFor word +3, each caption word +2,
each filename word +1, explicit photo/video/voice request +5
with +3 for the matching kind, and +6 when the file's TYPE fits
what the customer asked about (deal question → offer banner,
price question → price list, greeting → logo/intro, "show me" →
demo). Only the highest-scoring file is sent, and only if it
scores 6 or more. A message about something else scores ~0 and
sends no media. The media is always sent WITH a short written
line in the customer's language, e.g. "Ye dekh lein — hamari offer
ka banner hai, aaj ki deal ye hai" — never a bare photo with no
explanation.

## WhatsApp policy safety — how the number stays safe from a ban

- **Only reply to incoming messages.** The bot never starts a
  conversation, never messages someone who did not message first,
  never mass-messages, never sends unsolicited promos or offers
  to a list of numbers, and never broadcasts.
- **One short reply per incoming message** (plus one media file
  only when it really fits). No follow-ups, no chasing, no
  repeating the same message.
- **Stop means stop.** If a customer says stop / no / "don't
  message me", the bot replies politely once and never messages
  them again.
- **Short and relevant.** Every reply answers what that customer
  actually asked — no spam, no bulk, no long paragraphs.
- These rules are built into the AI system prompt (`buildSystemPrompt`
  in `src/ai.js`) and into the server (`src/whatsapp.js` replies to
  incoming DMs only, never groups, never outbound campaigns).
- Pairing-code linking itself uses the unofficial WhatsApp Web
  protocol (Baileys). WhatsApp can log such sessions out, and
  numbers that spam get banned — following the rules above is what
  keeps the business number safe.

## Run locally

```bash
cd whatsapp-bot-platform
npm install
cp .env.example .env
# fill in .env (see below) — never commit .env
npm start
# open http://localhost:3000/
```

## Deploy to Render (FREE — Zaib approved 2026-11-20)

Vercel login was blocked by phone verification (Pakistan numbers,
2026-11-19 and again 2026-11-20), so Zaib said to deploy on Render
instead. Render free asks for no phone verification.

`render.yaml` is in this folder for a free web service:

- Service type: **Web Service**, plan **free**, environment **Node**
- Build command: `npm install`
- Start command: `node server.js`
- The server already binds `process.env.PORT` (Render sets `PORT`)
  and serves the dashboard from `public/`.

Steps (Zaib / parent agent — no keys are in this repo):

1. Create a free Render account at https://render.com (email signup,
   no phone verification).
2. Put this folder in a GitHub repo and push it (see "Files to
   commit" below). This folder is NOT a git repo yet and has NO
   GitHub remote — that step has not been done.
3. Render dashboard > New > Web Service > connect that GitHub repo
   (Render reads `render.yaml` automatically).
4. In the Render dashboard, Environment Variables, set:
   `GEMINI_API_KEY` and `RESEND_API_KEY` (real values, never in code).
5. Deploy. The live URL will be like
   `https://musa-whatsapp-bot.onrender.com` — that URL is the
   **bot server URL** to paste into the dashboard's Connect page.

### Render free limitation — honest note

Baileys sessions live in `data/auth/<businessId>/`, and businesses /
leads / uploaded media live in `data/` (JSON store + uploads).
On Render free there is **no persistent disk** (a persistent disk is
a paid add-on), and the free instance also sleeps after inactivity
and restarts. So on a restart / redeploy, the linked WhatsApp session,
saved businesses, leads and uploaded media in `data/` are lost and
the business will need to link WhatsApp again by pairing code.
There is no free persistence fix invented here — for real production
persistence, `data/` needs a persistent store (paid Render disk, a
small VPS, or a database / object storage) and `src/store.js` is the
seam to replace with a real DB. The same limitation applied on
Vercel's ephemeral filesystem.

## Deploy to Vercel (alternative — currently blocked)

Vercel login was blocked by phone verification, so Render is the
chosen route above. If Vercel is used later instead:

```bash
npm i -g vercel
vercel
# then in the Vercel dashboard: Settings > Environment Variables,
# add GEMINI_API_KEY and RESEND_API_KEY
vercel --prod
```

Note: Baileys sessions live in `data/auth/<businessId>/`. On Vercel's
ephemeral filesystem sessions do not persist across deploys — for
production, move `data/` to a persistent store (e.g. Vercel Blob /
a small VPS / Supabase) and keep the same file layout. The JSON store
in `src/store.js` is the seam to replace with a real DB.

## Env vars (placeholders only — no real keys in this repo)

| Var | Where to get it | Cost |
|---|---|---|
| `GEMINI_API_KEY` | Google AI Studio — https://aistudio.google.com/ → Get API key | Free tier |
| `GEMINI_MODEL` | default `gemini-2.5-flash` | — |
| `RESEND_API_KEY` | https://resend.com/api-keys | Free tier, 3,000/month |
| `RESEND_FROM_EMAIL` | a verified sender, default `onboarding@resend.dev` | — |
| `PORT` | default `3000` | — |
| `DATA_DIR` | default `./data` | — |

## API endpoints

| Method | Endpoint | What it does |
|---|---|---|
| POST | `/api/business/:id/pairing-code` `{phone}` | REAL Baileys pairing code for that business's number, live, with `expiresInSeconds: 60`; 400 on invalid phone, 409 if already linked or a code is already being requested, 429 if WhatsApp rate-limited THIS number or a code was just requested for it (with how long to wait — do NOT retry, retrying extends WhatsApp's limit), 500 with the real error if Baileys fails — never a fake code |

> **Pairing is per phone, not per business (2026-11-20):** one request sends exactly one registration to WhatsApp (clean identity per number, standard Ubuntu/Chrome browser identity, one socket, in-flight guard against double-taps). A rate limit earned by one number never blocks a different number — switching numbers starts from a clean identity for that number. Only a code WhatsApp confirms is ever shown.
| GET | `/api/business/:id/status` | Business settings + WhatsApp link status (`linked`, `whatsappStatus`, `pairingExpiresAt`) |
| POST | `/api/business/:id/disconnect` | Log the linked WhatsApp out |
| POST | `/api/business/:id/settings` `{name, prompt, leadEmail, leadWhatsapp}` | Save prompt / notification settings (partial updates) |
| POST | `/api/business/:id/media` (multipart `file`, `caption`, `useFor`) | Upload image / video / audio (max 16 MB) |
| GET | `/api/business/:id/media` | List uploaded media |
| DELETE | `/api/business/:id/media/:mediaId` | Delete media item + file |
| GET | `/api/business/:id/leads` | Leads for that business, newest first |
| POST | `/api/business/:id/leads` `{customerName, customerNumber, address, wants}` | Add a real lead (customerNumber + wants required, 400 if blank) |
| POST | `/api/business/:id/leads/:leadId/confirm` | Mark confirmed + forward to saved email + WhatsApp |
| GET | `/api/health` | Health check |

## Files

- `server.js` — Express server + all API routes
- `src/whatsapp.js` — Baileys pairing-code sessions, incoming DM handling
- `src/ai.js` — Gemini reply generation (short, friendly, prompt-guided, media pick by `useFor`)
- `src/leads.js` — lead capture, name/address parsing, confirm + Resend email + owner WhatsApp forwarding, graceful fallback with `forwardLog`
- `src/store.js` — JSON store: businesses + leads (`getLead`, `updateLead` included)
- `public/index.html` — dashboard (5 sections, in order)
- `public/style.css` — professional dashboard styling (Musa branding, responsive, status badges)
- `public/app.js` — dashboard logic: pairing code with 60s countdown, status refresh, prompt save, media list/delete, notification settings, manual lead, leads + confirm
- `.env.example`, `.gitignore`

## Verification (done 2026-11-20, rebuild)

- `node --check` passed on all JS files; `npm install` succeeded.
- Server started on port 3000; `/api/health` OK; dashboard `/`,
  `/style.css`, `/app.js` all HTTP 200.
- End-to-end curl test on a fresh business (empty start): status
  → save prompt → save notification settings → upload test image
  → list media → add a real lead (name/number/wants, no defaults)
  → list leads → confirm lead (graceful fallback shown: email not
  sent because `RESEND_API_KEY` is not set, WhatsApp not sent
  because no session is linked — lead still marked confirmed, with
  the reason recorded) → delete media → list empty again.
- Pairing endpoint: invalid phone (e.g. `123`) rejected with 400
  and NO code returned; no fake code is generated anywhere in the
  code. The live pairing-code call itself was NOT run in the test —
  it opens a real Baileys session for a real phone number, so it
  must be tested by Zaib with his own number after deploy.
- Test business / leads / uploads were cleaned up afterwards;
  `data/` is empty, `node_modules/` removed.

## What still needs Zaib

1. **Gemini API key** — create it in Google AI Studio as
   `musasocialstore000@gmail.com` (Get API key → Create API key,
   name it "Musa WhatsApp Bot"), then put it in `.env` as
   `GEMINI_API_KEY`. Note: the browser attempt on 2026-11-19 hit an
   age-verification redirect while signed in as kinghacker0997ppp;
   sign in as Musa Store first.
2. **Resend API key value** — free account is already created for
   musasocialstore000@gmail.com (free tier 3,000/month, 100/day;
   one key named "Onboarding" exists on resend.com/api-keys). Copy
   its value into `.env` as `RESEND_API_KEY` (if the value was not
   saved when it was created, create a new key on that page).
3. **Deploy on Render (free)** — see "Deploy to Render" above.
   Zaib approved Render on 2026-11-20 after Vercel phone
   verification blocked login twice. Still needed: a free Render
   account, this folder pushed to a GitHub repo, then connect that
   repo in Render and set `GEMINI_API_KEY` / `RESEND_API_KEY` in
   Render's Environment Variables. Vercel is no longer the route.
4. **Test with one business first** — link Musa Social Store's own
   number, set the prompt, send a real customer message from another
   phone, confirm a real lead, check it arrives by email + WhatsApp, before
   onboarding other businesses.

## Safety / WhatsApp policy

See "WhatsApp policy safety" above — the bot only replies to
incoming DMs, never mass-messages, never broadcasts, and stops
when a customer says stop. Pairing-code linking uses the
unofficial WhatsApp Web protocol (Baileys); WhatsApp can log
such sessions out, and numbers that spam get banned.
