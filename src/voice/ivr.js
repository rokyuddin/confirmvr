'use strict';
/**
 * Builds the IVR script for an order confirmation call.
 *
 * Static parts can be pre-recorded audio (public/audio/*.mp3) for a natural voice;
 * dynamic parts (page name, product, amount) are Bangla TTS.
 *
 * Customer hears:
 *  "আসসালামু আলাইকুম, [পেজ] থেকে বলছি। আপনি [প্রোডাক্ট] অর্ডার করেছেন, মোট [৳১২৫০]।
 *   অর্ডার নিশ্চিত করতে ১ চাপুন, বাতিল করতে ২, কারো সাথে কথা বলতে ৩।"
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { bnTaka } = require('../util');

const AUDIO_DIR = path.join(__dirname, '..', '..', 'public', 'audio');
function staticPrompt(file, fallbackText) {
  if (fs.existsSync(path.join(AUDIO_DIR, file))) return { type: 'audio', url: `${config.baseUrl}/audio/${file}` };
  return { type: 'tts', text: fallbackText, lang: 'bn-BD' };
}
const tts = (text) => ({ type: 'tts', text, lang: 'bn-BD' });

function fullText(seller, order) {
  return (
    `আসসালামু আলাইকুম, ${seller.page_name} থেকে বলছি। ` +
    `আপনি ${order.product_spoken || order.product} অর্ডার করেছেন, মোট ${bnTaka(order.amount)}। ` +
    'অর্ডার নিশ্চিত করতে ১ চাপুন, বাতিল করতে ২, কারো সাথে কথা বলতে ৩।'
  );
}

function buildScript(seller, order) {
  const prompts = [];
  if (seller.voice_mode === 'recorded' && seller.recorded_intro_url) {
    prompts.push({ type: 'audio', url: seller.recorded_intro_url }); // seller's own voice greeting
  } else {
    prompts.push(staticPrompt('greeting.mp3', 'আসসালামু আলাইকুম,'));
    prompts.push(tts(`${seller.page_name} থেকে বলছি।`));
  }
  prompts.push(tts(`আপনি ${order.product_spoken || order.product} অর্ডার করেছেন, মোট ${bnTaka(order.amount)}।`));
  prompts.push(staticPrompt('menu.mp3', 'অর্ডার নিশ্চিত করতে ১ চাপুন, বাতিল করতে ২, কারো সাথে কথা বলতে ৩।'));

  const onDigit = {
    1: { action: 'play_and_hangup', prompt: staticPrompt('confirmed.mp3', 'ধন্যবাদ, আপনার অর্ডার নিশ্চিত করা হয়েছে।') },
    2: { action: 'play_and_hangup', prompt: staticPrompt('cancelled.mp3', 'আপনার অর্ডার বাতিল করা হয়েছে। ধন্যবাদ।') },
    3: seller.phone
      ? { action: 'forward', to: seller.phone, prompt: staticPrompt('forwarding.mp3', 'অনুগ্রহ করে অপেক্ষা করুন, আপনাকে সংযুক্ত করা হচ্ছে।') }
      : { action: 'play_and_hangup', prompt: staticPrompt('callback.mp3', 'ধন্যবাদ, আমাদের প্রতিনিধি শীঘ্রই আপনাকে কল করবেন।') },
  };

  return { prompts, gather: { num_digits: 1, timeout_sec: 8, repeat: 2 }, onDigit, text: fullText(seller, order) };
}

module.exports = { buildScript, fullText };
