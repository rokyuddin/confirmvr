# কনফার্ম কল (Confirm Call)

অর্ডার আসার কয়েক মিনিটের মধ্যে কাস্টমারের কাছে বাংলায় অটো কল যায়। কাস্টমার ১ চাপলে অর্ডার **কনফার্মড**, ২ চাপলে **বাতিল**, ৩ চাপলে কল সেলারের নম্বরে ফরওয়ার্ড হয় আর সেলার "কল ব্যাক করুন" নোটিফিকেশন পায়।

> "আসসালামু আলাইকুম, [পেজের নাম] থেকে বলছি। আপনি [প্রোডাক্ট] অর্ডার করেছেন, মোট [১,২৫০ টাকা]। অর্ডার নিশ্চিত করতে ১ চাপুন, বাতিল করতে ২, কারো সাথে কথা বলতে ৩।"

## চালানো

Node.js 22.13+ লাগবে (বিল্ট-ইন `node:sqlite` ব্যবহার করা হয়েছে, তাই আলাদা ডাটাবেস বা Redis লাগে না)।

```bash
npm install
cp .env.example .env     # SESSION_SECRET, ADMIN_TOKEN বদলান
npm start                # http://localhost:3000
npm test
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
| এক ক্লিকে কুরিয়ার: Steadfast, Pathao, RedX | `src/services/courier.js` |
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

সেলার `/billing` পেজ থেকে TrxID জমা দেয়। আপনি bKash-এ যাচাই করে ক্রেডিট যোগ করবেন:

```bash
curl -X POST $BASE_URL/admin/topup -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"seller_id":"CVR3","amount":500,"trx_id":"BK8XYZ123"}'
```

একই TrxID দুইবার দিলে ক্রেডিট দুইবার যোগ হয় না। পরে bKash Payment Gateway (Tokenized Checkout) লাগালে তার webhook `X-Bkash-Signature` (body-র HMAC-SHA256, `BKASH_WEBHOOK_SECRET`) দিয়ে এই একই endpoint-এ পাঠানো যাবে।

## কুরিয়ার সেটিংস (JSON)

- Steadfast: `{"api_key":"...","secret_key":"..."}`
- Pathao: `{"client_id":"...","client_secret":"...","username":"...","password":"...","store_id":1,"city_id":1,"zone_id":1}`
- RedX: `{"token":"...","delivery_area":"Mirpur","delivery_area_id":1}`

ডেভেলপমেন্টে `COURIER_DRY_RUN=1` দিলে আসল বুকিং হয় না। লাইভে যাওয়ার আগে প্রতিটা কুরিয়ারের বর্তমান API ডকুমেন্টেশনের সাথে ফিল্ডগুলো মিলিয়ে নিন। Pathao আর RedX-এ সব অর্ডারের জন্য একটাই ডিফল্ট এলাকা ধরা হয়েছে; ঠিকানা থেকে আলাদা এলাকা বের করা পরের ধাপের কাজ।

## প্রোডাকশন চেকলিস্ট

- `SESSION_SECRET`, `ADMIN_TOKEN`, `VOICE_WEBHOOK_SECRET` লম্বা র‍্যান্ডম স্ট্রিং দিন, আর HTTPS-এ চালান (`BASE_URL=https://...`)।
- শুধু অর্ডার কনফার্মেশন কল করুন। মার্কেটিং কল করলে BTRC-র নিয়ম ভাঙবে, প্রোভাইডার একাউন্টও বন্ধ হতে পারে।
- এখানে কিউ হিসেবে SQLite টেবিল (`orders.next_call_at`) ব্যবহার করা হয়েছে, যেটা একটা সার্ভারে ভালো চলে। একাধিক সার্ভারে চালাতে হলে `calls.tick()` এর জায়গায় BullMQ/Redis বসান।
- `data/` ফোল্ডারের নিয়মিত ব্যাকআপ রাখুন।

## স্ট্রাকচার

```
src/
  server.js, app.js, config.js, db.js (স্কিমা), auth.js, util.js
  routes/web.js            সেলার ড্যাশবোর্ড ও পেজগুলো
  routes/integrations.js   webhook, API, ভয়েস কলব্যাক, অ্যাডমিন টপআপ
  services/                orders, calls (শিডিউলার), billing, sheets, courier, risk, notify
  voice/                   ivr (কল স্ক্রিপ্ট), mock, http (প্রোভাইডার অ্যাডাপ্টার)
test/core.test.js
```
