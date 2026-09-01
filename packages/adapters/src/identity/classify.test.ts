import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUSPECT_DELTA_RATIO, classifyResponse, classifySnapshot } from './classify.js';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', name), 'utf8');

describe('Amazon response classification', () => {
  it('reads a real robot-check page as a hard block', () => {
    const verdict = classifyResponse({
      marketplace: 'amazon_in',
      status: 200,
      body: fixture('amazon/robot-blocked.html'),
    });
    expect(verdict.classification).toBe('hard_block');
  });

  it('reads a real CAPTCHA page as a hard block', () => {
    const verdict = classifyResponse({
      marketplace: 'amazon_in',
      status: 200,
      body: fixture('amazon/captcha.html'),
    });
    expect(verdict.classification).toBe('hard_block');
  });

  it('lets a real product page through', () => {
    for (const name of ['in-stock-basic', 'out-of-stock', 'deal-coupon-bank']) {
      const verdict = classifyResponse({
        marketplace: 'amazon_in',
        status: 200,
        body: fixture(`amazon/${name}.html`),
      });
      expect(verdict.classification, name).toBe('ok');
    }
  });

  it.each([403, 429, 503])('treats HTTP %i as a hard block', (status) => {
    expect(classifyResponse({ marketplace: 'amazon_in', status, body: '' }).classification).toBe(
      'hard_block',
    );
  });

  it.each([
    ['Robot Check', '<title>Robot Check</title>'],
    ['captcha form', '<form action="/errors/validateCaptcha" method="get">'],
    ['captcha input', '<input id="captchacharacters" name="field-keywords">'],
    ['enter the characters', '<p>Enter the characters you see below</p>'],
    ['sorry page', '<h1>Sorry! Something went wrong on our end.</h1>'],
    ['automated access', 'api-services-support@amazon.com'],
  ])('recognises the %s marker in a 200 body', (_label, body) => {
    expect(classifyResponse({ marketplace: 'amazon_in', status: 200, body }).classification).toBe(
      'hard_block',
    );
  });
});

describe('Flipkart response classification', () => {
  it('lets a real product page through', () => {
    for (const name of ['jsonld-in-stock', 'selectors-only', 'sold-out']) {
      const verdict = classifyResponse({
        marketplace: 'flipkart',
        status: 200,
        body: fixture(`flipkart/${name}.html`),
      });
      expect(verdict.classification, name).toBe('ok');
    }
  });

  it('reads the saved block page as a hard block', () => {
    const verdict = classifyResponse({
      marketplace: 'flipkart',
      status: 200,
      body: fixture('flipkart/blocked.html'),
    });
    expect(verdict.classification).toBe('hard_block');
    expect(verdict.reason).toBe('flipkart_no_product');
  });

  it('does NOT read a warm-up homepage as a block just because it has no product', () => {
    // Caught live: the first Flipkart warm-up of every new identity was
    // classified `flipkart_no_product` and cooled the identity that had just
    // been created, feeding the IP backoff with fictional evidence. A homepage
    // has no product BY DESIGN, so only its status can speak.
    const homepage =
      '<!DOCTYPE html><html lang="en-IN"><head><meta charset="UTF-8">' +
      '<link rel="dns-prefetch" href="https://1.rome.api.flipkart.com"></head><body></body></html>';
    expect(
      classifyResponse({ marketplace: 'flipkart', status: 200, body: homepage }).classification,
    ).toBe('hard_block');
    expect(
      classifyResponse({
        marketplace: 'flipkart',
        status: 200,
        body: homepage,
        expectProduct: false,
      }).classification,
    ).toBe('ok');
  });

  it('still reads a non-200 warm-up as a block', () => {
    expect(
      classifyResponse({ marketplace: 'flipkart', status: 429, body: '', expectProduct: false })
        .classification,
    ).toBe('hard_block');
  });

  it('still reads Amazon block vocabulary on a warm-up page', () => {
    // Amazon DOES announce its blocks, so its markers apply to a homepage too.
    expect(
      classifyResponse({
        marketplace: 'amazon_in',
        status: 200,
        body: '<title>Robot Check</title>',
        expectProduct: false,
      }).classification,
    ).toBe('hard_block');
  });

  it.each([403, 429, 500, 529])('treats ANY non-200 as a hard block (%i)', (status) => {
    // Flipkart does not announce blocks; it just stops serving product pages.
    // 529 in particular has been seen in the wild.
    const verdict = classifyResponse({
      marketplace: 'flipkart',
      status,
      body: fixture('flipkart/jsonld-in-stock.html'),
    });
    expect(verdict.classification).toBe('hard_block');
    expect(verdict.reason).toBe(`flipkart_http_${status}`);
  });
});

describe('snapshot suspicion', () => {
  it('flags a page with a title but no price', () => {
    const verdict = classifySnapshot({
      name: 'HP Victus 15',
      price: null,
      lastAcceptedPrice: 62_990,
      outOfStock: false,
    });
    expect(verdict.classification).toBe('suspect');
    expect(verdict.reason).toBe('no_price');
  });

  it('does NOT flag an out-of-stock listing for having no price', () => {
    const verdict = classifySnapshot({
      name: 'HP Victus 15',
      price: null,
      lastAcceptedPrice: 62_990,
      outOfStock: true,
    });
    expect(verdict.classification).toBe('ok');
  });

  it('flags a non-positive price', () => {
    expect(
      classifySnapshot({ name: 'X', price: 0, lastAcceptedPrice: 100, outOfStock: false }).reason,
    ).toBe('non_positive_price');
  });

  it('flags a move larger than 40% against the last accepted price', () => {
    const base = 100_000;
    const justUnder = classifySnapshot({
      name: 'X',
      price: base * (1 - SUSPECT_DELTA_RATIO) + 1,
      lastAcceptedPrice: base,
      outOfStock: false,
    });
    const justOver = classifySnapshot({
      name: 'X',
      price: base * (1 - SUSPECT_DELTA_RATIO) - 1,
      lastAcceptedPrice: base,
      outOfStock: false,
    });
    expect(justUnder.classification).toBe('ok');
    expect(justOver.classification).toBe('suspect');
    expect(justOver.reason).toBe('price_jump');
  });

  it('accepts any price when there is no history to compare against', () => {
    expect(
      classifySnapshot({ name: 'X', price: 1, lastAcceptedPrice: null, outOfStock: false })
        .classification,
    ).toBe('ok');
  });
});
