// A cheap pre-filter so the AI (and its per-account hourly budget - server/src/routes/ai.js) is
// only spent on messages that plausibly contain a load. Greetings, questions ("кто едет в
// Москву?"), forwarded ads and general chatter are most of the traffic in a big group and cost
// nothing to skip here. False negatives are fine (a missed load just needs someone to re-post);
// false positives only cost one AI call, so this stays deliberately loose.

const PHONE = /\+?\d[\d\s().-]{7,}\d/;
const USERNAME = /@[a-zA-Z]\w{3,31}/;
const FLAG = /\p{Regional_Indicator}{2}/u;
// Loading/payment/equipment words that show up in real freight posts across RU/UZ/EN.
const FREIGHT_WORDS = /ТЕНТ|ШТОРА|РЕФ|БОРТ|ФУРА|ФУРГОН|АВТОВОЗ|ОПЛАТА|ПОГРУЗКА|АВАНС|НАХТ|НАКД|ТАЙЁР|ТАЙЙОР|ГОТОВ|TENT|FURA|REFR?\b|TONN?A?\b/i;

export function looksLikeLoad(text, { minChars = 25, requireContact = true } = {}) {
  const s = String(text ?? '').trim();
  if (s.length < minChars) return false;
  const hasContact = PHONE.test(s) || USERNAME.test(s);
  if (requireContact && !hasContact) return false;
  return hasContact || FLAG.test(s) || FREIGHT_WORDS.test(s);
}
