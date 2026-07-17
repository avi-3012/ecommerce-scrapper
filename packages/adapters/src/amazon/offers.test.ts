import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import type { RawPage } from '../adapter.js';
import { CheckError } from '../errors.js';
import type { FetchFn } from '../fetch/http.js';
import {
  buildSecondaryViewUrl,
  collectAmazonOffers,
  injectOffers,
  parseSecondaryViewOffers,
  readInjectedOffers,
} from './offers.js';

const card = (contentId: string, title: string, summary: string, count: number): string => `
  <div class="offers-items">
    <span class="a-declarative" data-action="side-sheet"
      data-side-sheet='{"smid":"","contentId":"${contentId}","encryptedMerchantId":"M1","buyingOptionIndex":0,"sr":"SR1"}'>
      <h6 class="offers-items-title">${title}</h6>
      <div class="offers-items-content"><span class="a-truncate-full">${summary}</span></div>
      <a class="vsx-offers-count" href="#">${count} offer${count === 1 ? '' : 's'}</a>
    </span>
  </div>`;

const secondaryView = (items: string[]): string =>
  `<div>${items
    .map(
      (t, i) =>
        `<div class="vsx-offers-desktop-lv__item">Offer ${i + 1} ${t} <a href="#">See details</a></div>`,
    )
    .join('')}</div>`;

function stubFetch(routes: Record<string, string>): FetchFn {
  return (url: string): Promise<RawPage> => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : undefined;
    if (body === undefined)
      return Promise.reject(new CheckError('http_error', `no stub for ${url}`));
    return Promise.resolve({ url, body, tier: 'http', fetchedAt: new Date() });
  };
}

describe('parseSecondaryViewOffers', () => {
  it('extracts each individual offer, stripping the positional "Offer N" prefix and See-details link', () => {
    const items = parseSecondaryViewOffers(
      secondaryView([
        'Flat INR 8000 Instant Discount on ICICI Bank Credit Card',
        'Flat INR 8000 Instant Discount on HDFC Bank Credit Card',
      ]),
    );
    expect(items).toEqual([
      'Flat INR 8000 Instant Discount on ICICI Bank Credit Card',
      'Flat INR 8000 Instant Discount on HDFC Bank Credit Card',
    ]);
  });
});

describe('buildSecondaryViewUrl', () => {
  it('carries the card config into the side-sheet endpoint params', () => {
    const url = buildSecondaryViewUrl('B0X', {
      contentId: 'InstantBankDiscount',
      encryptedMerchantId: 'M1',
      sr: 'SR1',
      buyingOptionIndex: 0,
    });
    expect(url).toContain('/gp/product/ajax/vsxOffersSecondaryView');
    expect(url).toContain('asin=B0X');
    expect(url).toContain('offerType=InstantBankDiscount');
    expect(url).toContain('encryptedMerchantId=M1');
    expect(url).toContain('sr=SR1');
  });
});

describe('collectAmazonOffers', () => {
  it('expands a multi-offer card into its individual offers and keeps single-offer summaries', async () => {
    const html =
      card('InstantBankDiscount', 'Bank Offer', 'Upto ₹8,000 discount on select Credit Cards', 3) +
      card('GCCashback-single-offer', 'Cashback', 'Upto ₹2,609 cashback with Amazon Pay', 1);
    const offers = await collectAmazonOffers(
      html,
      'B0X',
      stubFetch({
        'offerType=InstantBankDiscount': secondaryView([
          'Flat INR 8000 Instant Discount on ICICI Bank Credit Card',
          'Flat INR 8000 Instant Discount on HDFC Bank Credit Card',
          'Flat INR 8000 Instant Discount on Axis Bank Credit Card',
        ]),
      }),
    );
    const descriptions = offers!.map((o) => o.description);
    expect(descriptions).toContain('Flat INR 8000 Instant Discount on ICICI Bank Credit Card');
    expect(descriptions).toContain('Flat INR 8000 Instant Discount on Axis Bank Credit Card');
    // The single-offer card contributes its summary directly (no fetch).
    expect(descriptions).toContain('Upto ₹2,609 cashback with Amazon Pay');
    expect(offers).toHaveLength(4);
  });

  it('returns null when the page has no offer cards', async () => {
    expect(await collectAmazonOffers('<div>no offers</div>', 'B0X', stubFetch({}))).toBeNull();
  });

  it('excludes the B2B "Partner Offers" (GST invoice) card', async () => {
    const html =
      card('GCCashback-single-offer', 'Cashback', 'Upto ₹2,609 cashback with Amazon Pay', 1) +
      card(
        'Partner-single-offer',
        'Partner Offers',
        'Get GST invoice and save up to 18% on business purchases. Sign up for free',
        1,
      );
    const offers = await collectAmazonOffers(html, 'B0X', stubFetch({}));
    expect(offers).toHaveLength(1);
    expect(offers?.[0]?.description).toContain('cashback');
  });

  it('fails as parse_failed when a multi-offer card yields no individual offers (no toleration)', async () => {
    const html = card('InstantBankDiscount', 'Bank Offer', 'Upto ₹8,000 discount', 3);
    await expect(
      collectAmazonOffers(
        html,
        'B0X',
        stubFetch({ 'offerType=InstantBankDiscount': '<div></div>' }),
      ),
    ).rejects.toMatchObject({ reason: 'parse_failed' });
  });

  it('fails as parse_failed when a multi-offer card exposes no side-sheet config', async () => {
    const html = `<div class="offers-items">
      <h6 class="offers-items-title">Bank Offer</h6>
      <div class="offers-items-content">Upto ₹8,000 discount</div>
      <a class="vsx-offers-count">3 offers</a></div>`;
    await expect(collectAmazonOffers(html, 'B0X', stubFetch({}))).rejects.toMatchObject({
      reason: 'parse_failed',
    });
  });
});

describe('offer injection round-trip', () => {
  it('injects and reads back enriched offers', () => {
    const offers = [{ label: 'Bank Offer', description: 'Flat INR 8000 on ICICI <b>Card</b>' }];
    const $ = cheerio.load(injectOffers('<html><body>page</body></html>', offers));
    expect(readInjectedOffers($)).toEqual(offers);
  });

  it('reads null when no marker is present', () => {
    expect(readInjectedOffers(cheerio.load('<html></html>'))).toBeNull();
  });
});
