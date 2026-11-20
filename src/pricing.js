'use strict';
/**
 * Pricing plans. 1 credit = 1 answered confirmation call (up to ~1 minute).
 * Unanswered attempts and retries are free. Credits never expire.
 *
 * NOTE: these prices are placeholders until the voice provider's per-minute rate is
 * known. Keep at least ~40% margin over (provider rate × average call minutes + TTS).
 */
const config = require('./config');
const { toBnDigits } = require('./util');

const PLANS = [
  {
    id: 'free', name: 'ফ্রি', price: 0, credits: 0, perMonthFree: true,
    tagline: 'নিজে যাচাই করে দেখুন',
    features: [`প্রতি মাসে ${toBnDigits(config.freeCallsPerMonth)}টা কল ফ্রি`, 'Sheet, WooCommerce, Shopify, Steadfast', 'অটো রিট্রাই ও রিস্ক ফ্ল্যাগ', 'কার্ড লাগবে না'],
  },
  {
    id: 'starter', name: 'স্টার্টার', price: 500, credits: 400,
    tagline: 'ছোট পেজের জন্য',
    features: ['৪০০ কল', 'প্রতি কল ১.২৫ টাকা', 'সব ফিচার চালু', 'ক্রেডিটের মেয়াদ নেই'],
  },
  {
    id: 'growth', name: 'গ্রোথ', price: 1500, credits: 1400, popular: true,
    tagline: 'নিয়মিত সেল হয় এমন পেজের জন্য',
    features: ['১,৪০০ কল', 'প্রতি কল ~১.০৭ টাকা', 'সব ফিচার চালু', 'ক্রেডিটের মেয়াদ নেই'],
  },
  {
    id: 'pro', name: 'প্রো', price: 4000, credits: 4000,
    tagline: 'বড় ব্যবসার জন্য',
    features: ['৪,০০০ কল', 'প্রতি কল ১ টাকা', 'সব ফিচার চালু', 'ক্রেডিটের মেয়াদ নেই'],
  },
];

/** Credits for a payment: exact pack price gets the pack, otherwise the base rate. */
function creditsForPayment(taka) {
  const amt = Number(taka);
  const pack = PLANS.find((p) => p.price > 0 && p.price === amt);
  if (pack) return pack.credits;
  return Math.floor((amt / config.takaPerCredit) * 100) / 100;
}

module.exports = { PLANS, creditsForPayment };
