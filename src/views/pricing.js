'use strict';
const { PLANS } = require('../pricing');
const { esc, toBnDigits } = require('../util');

const taka = (n) => toBnDigits(Number(n).toLocaleString('en-IN'));

/** Pricing cards. `cta` = where the buttons go ('/signup' or '/billing'). */
function pricingCards({ cta = '/signup', compact = false } = {}) {
  const cards = PLANS.map((p) => {
    const perCall = p.credits ? (p.price / p.credits).toFixed(2).replace(/\.00$/, '') : null;
    const href = p.price === 0 ? cta : cta === '/billing' ? `/billing?plan=${p.id}#pay` : cta;
    return `<div class="plan${p.popular ? ' popular' : ''}">
  ${p.popular ? '<span class="ribbon">সবচেয়ে জনপ্রিয়</span>' : ''}
  <h3>${esc(p.name)}</h3>
  <p class="muted">${esc(p.tagline)}</p>
  <div class="price">${p.price === 0 ? 'ফ্রি' : `৳${taka(p.price)}`}</div>
  <p class="muted">${p.price === 0 ? 'প্রতি মাসে' : `${taka(p.credits)} কল · প্রতি কল ৳${toBnDigits(perCall)}`}</p>
  ${compact ? '' : `<ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`}
  ${cta === '/billing' && p.price === 0 ? '<span class="muted">চালু আছে</span>' : `<a class="btn${p.popular ? '' : ' ghost'}" href="${href}">${p.price === 0 ? 'ফ্রি শুরু করুন' : 'কিনুন'}</a>`}
</div>`;
  }).join('');
  return `<div class="plans">${cards}</div>
<p class="muted center">শুধু কাস্টমার কল ধরলেই ক্রেডিট কাটে। না ধরলে বা রিট্রাই কলে কোনো চার্জ নেই। ক্রেডিটের মেয়াদ শেষ হয় না। bKash দিয়ে পেমেন্ট।</p>`;
}

module.exports = { pricingCards };
