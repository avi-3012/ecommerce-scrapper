import type { RawOffer } from '../offers.js';

/**
 * Flipkart individual-offer extraction.
 *
 * Flipkart product pages are client-rendered: the "Available offers" bullets are
 * not in the server HTML, but the page ships the full offer data in a
 * `window.__INITIAL_STATE__` JSON blob. Each offer is a `NepOffers` object with
 * an `offerTitle` (the bank/wallet, e.g. "Flipkart Axis", or a category like
 * "Bank offers"), a subtitle, and an amount. We parse that blob and pull out the
 * individual offers.
 *
 * The same blob also carries the EMI installment table (one row per bank, "₹X
 * off/m (N months)") — those are payment plans, not promotions, so they are
 * excluded to keep offer-change alerts meaningful.
 */

/** Isolate the `window.__INITIAL_STATE__` object via a string-aware brace scan. */
export function extractInitialState(html: string): unknown | null {
  const marker = html.indexOf('window.__INITIAL_STATE__');
  if (marker === -1) return null;
  const start = html.indexOf('{', marker);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const CATEGORY_LABEL: Record<string, string> = {
  EXCHANGE: 'Exchange offer',
  PBO: 'Bank offer',
  PBO_EMI: 'No Cost EMI',
};

interface NepOffer {
  type?: string;
  offerTitle?: string;
  offerType?: string;
  offerSubTitleRC?: unknown;
}

/** First text leaf inside a Flipkart "RichContent" subtitle tree. */
function firstText(node: unknown): string | null {
  let found: string | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.contentValue === 'string' && obj.contentValue.trim()) {
      found = obj.contentValue;
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  return found;
}

/** First rupee/percent amount label within an offer object. */
function firstAmount(node: unknown): string | null {
  let found: string | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.metaInfoLabelValue === 'string' && /₹|%/.test(obj.metaInfoLabelValue)) {
      found = obj.metaInfoLabelValue;
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  return found;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Extract the individual promotional offers from a Flipkart page's state JSON. */
export function extractFlipkartOffers(html: string): RawOffer[] {
  const state = extractInitialState(html);
  if (!state) return [];

  const offers: RawOffer[] = [];
  const seen = new Set<string>();

  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as NepOffer & Record<string, unknown>;
    if (node.type === 'NepOffers' && node.offerTitle) {
      const sub = clean(firstText(node.offerSubTitleRC) ?? '');
      let amount = clean(firstAmount(node) ?? '');
      const isEmiPlan = /off\/m|\/month|\(\d+\s*months?\)/i.test(amount);
      if (/^₹\s*0\b|^0\b/.test(amount)) amount = ''; // ₹0 / placeholder = no real value
      // A real offer has a concrete amount or genuine promotional wording. Some
      // NepOffers are just category headers whose subtitle is a UI prompt
      // ("Or check these EMI plans", "Change pincode to exchange item") — those
      // carry no offer and must be dropped, even though they have an offerType.
      const hasValue = amount !== '' || /cashback|discount|instant|flat|\d+\s*%|\boff\b/i.test(sub);
      if (!isEmiPlan && hasValue) {
        const description = [node.offerTitle, sub, amount].filter(Boolean).join(' — ');
        const label = node.offerType ? CATEGORY_LABEL[node.offerType] : undefined;
        const key = `${node.offerTitle}|${amount}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          offers.push(label ? { label, description } : { description });
        }
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };

  walk(state);
  return offers.slice(0, 25); // guard against a runaway blob
}
