'use strict';
const { esc } = require('../util');

function layout({ title, seller, body, flash }) {
  return `<!doctype html>
<html lang="bn"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · কনফার্ম কল</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<header class="top">
  <a class="brand" href="/">📞 কনফার্ম কল</a>
  ${seller ? `<nav>
    <a href="/dashboard">ড্যাশবোর্ড</a>
    <a href="/orders/new">নতুন অর্ডার</a>
    <a href="/risk">রিস্ক</a>
    <a href="/billing">ক্রেডিট</a>
    <a href="/settings">সেটিংস</a>
    <form method="post" action="/logout" class="inline"><button class="link">লগআউট</button></form>
  </nav>` : `<nav><a href="/login">লগইন</a><a href="/signup" class="btn">ফ্রি শুরু করুন</a></nav>`}
</header>
<main>
${flash ? `<div class="flash ${esc(flash.type || 'ok')}">${esc(flash.msg)}</div>` : ''}
${body}
</main>
<footer>শুধুমাত্র অর্ডার কনফার্মেশন কল · মার্কেটিং কল নয় · কল সময় সকাল ৯টা–রাত ৯টা</footer>
</body></html>`;
}

module.exports = { layout };
