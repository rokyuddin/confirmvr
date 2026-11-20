# কনফার্ম কল (Confirm Call)

অর্ডার আসার কয়েক মিনিটের মধ্যে কাস্টমারের কাছে বাংলায় অটো কল যায়। কাস্টমার ১ চাপলে অর্ডার **কনফার্মড**, ২ চাপলে **বাতিল**, ৩ চাপলে কল সেলারের নম্বরে ফরওয়ার্ড হয় আর সেলার "কল ব্যাক করুন" নোটিফিকেশন পায়।

> "আসসালামু আলাইকুম, [পেজের নাম] থেকে বলছি। আপনি [প্রোডাক্ট] অর্ডার করেছেন, মোট [১,২৫০ টাকা]। অর্ডার নিশ্চিত করতে ১ চাপুন, বাতিল করতে ২, কারো সাথে কথা বলতে ৩।"

## চালানো

Node.js 22.13+ লাগবে। `DATABASE_URL` দিলে Postgres (Neon) ব্যবহার হয়, না দিলে লোকাল SQLite ফাইল। Redis লাগে না।

```bash
npm install
cp .env.example .env     # SESSION_SECRET, ADMIN_TOKEN বদলান
npm start                # http://localhost:3000
npm test                 # SQLite-এ
TEST_DATABASE_URL=postgres://... npm test   # একই টেস্ট Postgres-এ
```

ডিফল্ট `VOICE_PROVIDER=mock`, তাই আসল কল যায় না। ড্যাশবোর্ডে "কল চলছে" অর্ডারে ১/২/৩ বাটন চেপে ফলাফল সিমুলেট করা যায়। অথবা `MOCK_AUTO_ANSWER=1` দিলে প্রতিটা কল নিজে থেকেই "১" চাপা হিসেবে ধরা হবে।

## ফিচার

| ফিচার | কোথায় |
|---|---|
| ম্যানুয়াল অর্ডার ফর্ম + CSV পেস্ট | `/orders/new` |
| Google Sheet সিঙ্ক (Publish to web → CSV লিংক, প্রতি ৫ মিনিটে; বাংলা/ইংরেজি হেডার) | `src/services/sheets.js` |
| WooCommerce / Shopify webhook (HMAC সিগনেচার যাচাই) | `/webhooks/woocommerce/:token`, `/webhooks/shopify/:token` |
| JSON API | `POST /api/orders` (`X-Api-Key`) |
| অটো রিট্রাই: ৩০ মিনিট, তারপর ২ ঘণ্টা, তারপর "ধরেনি" | `src/services/calls.js` |
| কল সময় সকাল ৯টা–রাত ৯টা (ঢাকা); রাতের অর্ডার পরদিন সকালে | `clampToCallWindow` |
| ৩ চাপলে ফরওয়ার্ড + নোটিফিকেশন (`NOTIFY_WEBHOOK_URL` দিয়ে SMS/Telegram) | `src/voice/ivr.js`, `src/services/notify.js` |
| ড্যাশবোর্ড: কনফার্মড / বাতিল / ধরেনি / নম্বর ভুল / কল ব্যাক | `/dashboard` |
| এক ক্লিকে Steadfast বুকিং (একটা বা সব কনফার্মড একসাথে), ডেলিভারি স্ট্যাটাস webhook, ফ্রড চেক, ব্যালেন্স টেস্ট | `src/services/steadfast.js` |
| Pathao, RedX (বেটা) | `src/services/courier.js` |
| OpenRouter: প্রোডাক্টের নাম শুদ্ধ উচ্চারণের বাংলায় (TTS-এর জন্য), Messenger মেসেজ পেস্ট করে অর্ডার | `src/services/llm.js` |
| প্রাইসিং প্ল্যান (ফ্রি / স্টার্টার / গ্রোথ / প্রো) | `src/pricing.js`, `/pricing` |
| Google Sheet টেমপ্লেট | `/sheet-template.csv` |
| রিস্ক ফ্ল্যাগ: বারবার বাতিল বা না ধরা নম্বর (সব সেলারের ডাটা মিলিয়ে) | `/risk` |
| মাসে প্রথম ৫০ কল ফ্রি, তারপর bKash প্রি-পেইড ক্রেডিট | `src/services/billing.js`, `/billing` |
| বাংলা TTS বা সেলারের নিজের রেকর্ড করা গলা | সেটিংস → ভয়েস |

## কল ফ্লো

```
অর্ডার এলো ──> pending (২ মিনিট পরে, কল সময়ের ভেতরে)
     │
     ▼
  calling ──> প্রোভাইডার POST /voice/callback
     ├─ answered + 1 ──> confirmed ──> [কুরিয়ারে পাঠান]
     ├─ answered + 2 ──> cancelled
     ├─ answered + 3 ──> callback (সেলারকে ফরওয়ার্ড + নোটিফিকেশন)
     ├─ invalid_number ─> wrong_number
     └─ no_answer/busy/failed/কোনো বাটন চাপেনি
          ├─ ১ম বার ──> ৩০ মিনিট পরে আবার
          ├─ ২য় বার ──> ২ ঘণ্টা পরে আবার
          └─ ৩য় বার ──> no_answer
ক্রেডিট না থাকলে ──> no_credit (রিচার্জ হলে নিজে থেকেই আবার কিউতে যায়)
১৫ মিনিটেও প্রোভাইডার কলব্যাক না দিলে ──> no_answer হিসেবে ধরা হয়
```

## আসল ভয়েস প্রোভাইডার কানেক্ট করা

`VOICE_PROVIDER=http` দিন, তারপর `VOICE_API_URL`, `VOICE_API_KEY`, `VOICE_CALLER_ID`, `VOICE_WEBHOOK_SECRET` সেট করুন। `src/voice/http.js` এর `toProviderPayload()` ফাংশনে আপনার বেছে নেওয়া BTRC-লাইসেন্সপ্রাপ্ত IPTSP-র API ফরম্যাট বসান। বাকি সিস্টেম বদলাতে হবে না।

প্রোভাইডার কল শেষে এই রিকোয়েস্ট পাঠাবে:

```http
POST /voice/callback
X-Webhook-Secret: <VOICE_WEBHOOK_SECRET>
{"call_id": 12, "status": "answered", "dtmf": "1", "duration": 18}
```

`status` হতে পারে: `answered | no_answer | busy | failed | invalid_number`। একই কলের জন্য বারবার কলব্যাক এলে শুধু প্রথমটা গোনা হয়।

**আরো স্বাভাবিক ভয়েস:** `public/audio/` ফোল্ডারে `greeting.mp3`, `menu.mp3`, `confirmed.mp3`, `cancelled.mp3`, `forwarding.mp3`, `callback.mp3` রাখলে সেগুলো রেকর্ড করা অডিও হিসেবে বাজবে। শুধু পেজের নাম, প্রোডাক্ট আর দাম TTS দিয়ে বানানো হবে।

## bKash রিচার্জ

সেলার `/billing` পেজ থেকে TrxID জমা দেয়। আপনি `/admin` প্যানেলে মিলিয়ে অনুমোদন দেবেন। অথবা স্ক্রিপ্ট থেকে:

```bash
curl -X POST $BASE_URL/admin/topup -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"seller_id":"CVR3","amount":500,"trx_id":"BK8XYZ123"}'
```

একই TrxID দুইবার দিলে ক্রেডিট দুইবার যোগ হয় না। পরে bKash Payment Gateway (Tokenized Checkout) লাগালে তার webhook `X-Bkash-Signature` (body-র HMAC-SHA256, `BKASH_WEBHOOK_SECRET`) দিয়ে এই একই endpoint-এ পাঠানো যাবে।

## প্রাইসিং

| প্ল্যান | দাম | কল | প্রতি কল |
|---|---|---|---|
| ফ্রি | ০ | প্রতি মাসে ৫০ | – |
| স্টার্টার | ৳৫০০ | ৪০০ | ৳১.২৫ |
| গ্রোথ | ৳১,৫০০ | ১,৪০০ | ~৳১.০৭ |
| প্রো | ৳৪,০০০ | ৪,০০০ | ৳১ |

১ ক্রেডিট = কাস্টমার ধরেছে এমন ১টা কল। না ধরলে বা রিট্রাই কলে চার্জ নেই, ক্রেডিটের মেয়াদ নেই, সব প্ল্যানে সব ফিচার। প্যাকের দামের সমান টাকা পাঠালে পুরো প্যাক, অন্য পরিমাণে `TAKA_PER_CREDIT` রেটে। **এই দামগুলো আপাতত বসানো।** প্রোভাইডারের প্রতি মিনিটের রেট জানার পর `src/pricing.js`-এ ঠিক করুন, যাতে খরচের ওপর কমপক্ষে ~৪০% মার্জিন থাকে।

## Steadfast

1. Steadfast প্যানেল → API → Your API keys থেকে Api-Key আর Secret-Key নিন।
2. সেটিংস → কুরিয়ার: Steadfast বেছে নিন, JSON দিন `{"api_key":"...","secret_key":"..."}`, তারপর "Steadfast কানেকশন টেস্ট" চাপুন (ব্যালেন্স দেখাবে)।
3. ডেলিভারি আপডেটের জন্য: সেটিংসে "নতুন token তৈরি করুন" চাপুন, তারপর Steadfast প্যানেল → Webhook-এ Callback URL আর Auth token বসান।
4. লাইভে `COURIER_DRY_RUN` সরিয়ে দিন। **Steadfast-এর কোনো স্যান্ডবক্স নেই**, লাইভ key দিয়ে প্রতিটা বুকিং আসল পার্সেল।

প্রতিটা অর্ডারের invoice হয় `CVR-<অর্ডার নম্বর>`। Steadfast একই invoice দুইবার নেয় না, তাই ডাবল ক্লিক বা টাইমআউটের পরে আবার চাপলে দুইবার বুক হয় না।

Steadfast-এর অফিসিয়াল ডকুমেন্টেশন এই সেশন থেকে খোলা যায়নি। এন্ডপয়েন্ট আর ফিল্ডগুলো npm-এর `steadfast-merchant-sdk` আর `steadfast-courier` প্যাকেজের সোর্স থেকে মেলানো (সেগুলো Steadfast-এর নিজের Laravel প্যাকেজের সাথে মিলিয়ে বানানো)। প্রথম আসল বুকিংয়ের আগে প্যানেলের API গাইডের সাথে একবার মিলিয়ে নিন।

## বাংলা ভয়েস (Azure TTS)

`AZURE_SPEECH_KEY` আর `AZURE_SPEECH_REGION` দিলে কলের সব লেখা Azure-এর বাংলাদেশি ভয়েসে অডিও হয়ে যায় (`bn-BD-NabanitaNeural` নারী, `bn-BD-PradeepNeural` পুরুষ; `TTS_VOICE` দিয়ে বদলান)। Azure-এর ফ্রি টায়ারে প্রতি মাসে ৫ লাখ অক্ষর।

- প্রতিটা লেখা একবারই অডিও করা হয়, তারপর ডাটাবেসে জমা থাকে আর `/tts/<hash>.mp3` থেকে প্রোভাইডার নিয়ে নেয়। মেনুর লাইন, পেজের নাম আর একই প্রোডাক্ট-দাম বারবার এলে নতুন করে খরচ হয় না।
- Azure কাজ না করলে লেখাটাই প্রোভাইডারের কাছে যায়, কল আটকায় না।
- টেলিফোনির জন্য প্রোভাইডার WAV চাইলে `TTS_FORMAT=riff-8khz-16bit-mono-pcm` দিন।
- কী তৈরি করবেন: Azure Portal → Create resource → **Speech** → Pricing tier **Free F0**। তারপর Keys and Endpoint থেকে key আর region (যেমন `southeastasia`) নিন।

## অ্যাডমিন প্যানেল

`/admin` এ `ADMIN_TOKEN` দিয়ে লগইন করুন।
- **টপআপ:** সেলারদের জমা দেওয়া bKash TrxID-এর তালিকা। bKash মার্চেন্ট অ্যাপে মিলিয়ে অনুমোদন দিলে ক্রেডিট যোগ হয়, আটকে থাকা অর্ডার আবার কলের তালিকায় যায় আর সেলার নোটিফিকেশন পায়। পরিমাণ ভুল থাকলে অনুমোদনের আগে ঠিক করা যায়, আর কারণ লিখে বাতিলও করা যায়।
- **সেলার:** সব সেলার, তাদের অর্ডার, কনফার্ম রেট আর ক্রেডিট। কারণ লিখে ক্রেডিট যোগ বা কমানো যায় (লেজারে থেকে যায়)।
- **পরিসংখ্যান:** আজ আর এই মাসের কল, কত শতাংশ ধরেছে, কাটা ক্রেডিট আর রিচার্জের টাকা।

## OpenRouter

`OPENROUTER_API_KEY` দিলে দুটো জিনিস চালু হয়, না দিলে আগের মতোই চলে:
- **কলের ভাষা:** "Men's Polo T-shirt XL x2" কলে শোনাবে "দুইটা মেনস পোলো টি-শার্ট, এক্স এল"। প্রতিটা অর্ডারে একবারই AI-কে জিজ্ঞেস করা হয় (`orders.product_spoken`-এ রাখা থাকে)। AI না চললে আসল নামটাই পড়া হয়।
- **মেসেজ থেকে অর্ডার:** নতুন অর্ডার পেজে কাস্টমারের Messenger বা WhatsApp মেসেজ পেস্ট করলে ফর্মটা নিজে থেকে পূরণ হয়। সেলার মিলিয়ে নিয়ে সেভ করে। দাম না লেখা থাকলে AI দাম আন্দাজ করে না।

মডেল বদলাতে `OPENROUTER_MODEL` দিন (ডিফল্ট `google/gemini-2.5-flash`)।

## Vercel-এ ডিপ্লয় (সাবডোমেইন: confirm.rokyuddin.com)

1. **রিপো ইমপোর্ট:** vercel.com → Add New → Project → `rokyuddin/confirmvr` বেছে নিন। Framework Preset: **Other**। বাকি সেটিং যেমন আছে তেমন থাকবে (`vercel.json` আছে)।
2. **ডাটাবেস:** প্রজেক্টের Storage ট্যাব → Marketplace → **Neon** → Create। এতে `DATABASE_URL` নিজে থেকেই সেট হয়ে যায়। প্রথম রিকোয়েস্টেই টেবিল তৈরি হয়ে যাবে।
3. **Environment Variables** (Settings → Environment Variables): `BASE_URL=https://confirm.rokyuddin.com`, `SESSION_SECRET`, `ADMIN_TOKEN`, `CRON_SECRET` (প্রতিটায় লম্বা র‍্যান্ডম স্ট্রিং, যেমন `openssl rand -hex 32`), দরকার হলে `OPENROUTER_API_KEY`, `BKASH_MERCHANT_NUMBER`, ভয়েস প্রোভাইডারের key। তারপর Redeploy।
4. **সাবডোমেইন:** Settings → Domains → `confirm.rokyuddin.com` যোগ করুন। তারপর যেখানে rokyuddin.com-এর DNS আছে (Cloudflare, Namecheap ইত্যাদি) সেখানে একটা রেকর্ড দিন:
   `CNAME  confirm  →  cname.vercel-dns.com` (Cloudflare হলে প্রক্সি বন্ধ রাখুন, শুধু DNS)। কয়েক মিনিটে SSL চালু হয়ে যাবে। অন্য নাম চাইলে `confirm`-এর জায়গায় সেটা দিন।
5. **প্রতি মিনিটে শিডিউলার চালানো:** Vercel-এ সার্ভার সবসময় চালু থাকে না, তাই কল পাঠানোর কাজটা একটা cron ডাকে। Vercel Hobby প্ল্যানে cron দিনে একবারের বেশি চলে না, তাই ফ্রি [cron-job.org](https://cron-job.org)-এ একটা জব বানান:
   URL `https://confirm.rokyuddin.com/api/cron/tick`, প্রতি ১ মিনিটে, হেডার `Authorization: Bearer <CRON_SECRET>`। এতে কল, রিট্রাই আর শিট সিঙ্ক তিনটাই চলে। (Vercel Pro থাকলে `vercel.json`-এ `"crons": [{"path":"/api/cron/tick","schedule":"* * * * *"}]` যোগ করলেও হবে; Vercel নিজে থেকেই `CRON_SECRET` হেডার পাঠায়।)
6. যাচাই: `https://confirm.rokyuddin.com/healthz` খুললে `{"ok":true}` দেখাবে।

## কুরিয়ার সেটিংস (JSON)

- Steadfast: `{"api_key":"...","secret_key":"..."}`
- Pathao: `{"client_id":"...","client_secret":"...","username":"...","password":"...","store_id":1,"city_id":1,"zone_id":1}`
- RedX: `{"token":"...","delivery_area":"Mirpur","delivery_area_id":1}`

ডেভেলপমেন্টে `COURIER_DRY_RUN=1` দিলে আসল বুকিং হয় না। লাইভে যাওয়ার আগে প্রতিটা কুরিয়ারের বর্তমান API ডকুমেন্টেশনের সাথে ফিল্ডগুলো মিলিয়ে নিন। Pathao আর RedX-এ সব অর্ডারের জন্য একটাই ডিফল্ট এলাকা ধরা হয়েছে; ঠিকানা থেকে আলাদা এলাকা বের করা পরের ধাপের কাজ।

## প্রোডাকশন চেকলিস্ট

- `SESSION_SECRET`, `ADMIN_TOKEN`, `VOICE_WEBHOOK_SECRET` লম্বা র‍্যান্ডম স্ট্রিং দিন, আর HTTPS-এ চালান (`BASE_URL=https://...`)।
- শুধু অর্ডার কনফার্মেশন কল করুন। মার্কেটিং কল করলে BTRC-র নিয়ম ভাঙবে, প্রোভাইডার একাউন্টও বন্ধ হতে পারে।
- কিউ হিসেবে `orders.next_call_at` কলাম ব্যবহার হয়। প্রতিটা অর্ডার কল দেওয়ার আগে ডাটাবেসে "দখল" করা হয়, তাই একসাথে কয়েকটা সার্ভার বা cron চললেও একই কাস্টমারকে দুইবার কল যায় না।
- Neon-এর ব্যাকআপ (point-in-time restore) চালু রাখুন।

## স্ট্রাকচার

```
src/
  server.js (সাধারণ সার্ভার), app.js, config.js, db.js (Postgres/SQLite + স্কিমা), auth.js, util.js, pricing.js
api/index.js               Vercel এন্ট্রি
  routes/web.js            সেলার ড্যাশবোর্ড ও পেজগুলো
  routes/integrations.js   webhook (Woo/Shopify/Steadfast), API, ভয়েস কলব্যাক, cron, অ্যাডমিন টপআপ
  routes/admin.js          অ্যাডমিন প্যানেল
  services/                orders, calls (শিডিউলার), billing, topups, sheets, steadfast, courier, tts (Azure), llm (OpenRouter), risk, notify
  voice/                   ivr (কল স্ক্রিপ্ট), mock, http (প্রোভাইডার অ্যাডাপ্টার)
test/core.test.js
```
