import { describe, expect, it } from 'vitest';
import { CheckError } from '../errors.js';
import { createTestSession } from '../identity/testing.js';
import type { SessionRequestOptions, SessionResponse } from '../identity/session.js';
import { amazonLocationApplied, amazonLocationCookie } from './location.js';

describe('amazonLocationApplied', () => {
  it('true when the glow ingress shows the requested pincode', () => {
    const html = '<html><body><span id="glow-ingress-line2">Mumbai 400001</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(true);
  });

  it('false when the location did not take (e.g. "Update location")', () => {
    const html = '<html><body><span id="glow-ingress-line2">Update location</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(false);
  });

  it('false when a different location was resolved', () => {
    const html = '<html><body><span id="glow-ingress-line2">Bengaluru 560001</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(false);
  });
});

const SEED = 'https://www.amazon.in/dp/B0TEST12345';

const reply = (body: string, statusCode = 200): SessionResponse => ({
  url: SEED,
  statusCode,
  body,
  headers: {},
  wireBytes: body.length,
});

const BLOCKED =
  '<html><body>To discuss automated access to Amazon data please contact ' +
  'api-services-support@amazon.com.</body></html>';
const NO_TOKEN = '<html><body><span id="productTitle">A laptop</span></body></html>';
const WITH_TOKEN =
  '<html><body><span id="nav-global-location-data-modal-action" ' +
  `data-a-modal='{"ajaxHeaders":{"anti-csrftoken-a2z":"tok123"}}'></span></body></html>`;

describe('amazonLocationCookie', () => {
  // 13 Sep 2026: the seed fetch went straight to `session.request`, skipping
  // classification. Fresh identities read a refusal as "no token", were never
  // cooled, never had `lastRequestAt` stamped, and least-recently-used rotation
  // handed each one straight back out — one identity failed six products in
  // three minutes.
  it('rethrows a refused seed as the block it is, and takes the identity out of rotation', async () => {
    const session = createTestSession('amazon_in');
    session.request = async () => reply(BLOCKED);

    await expect(amazonLocationCookie(session, '122001', SEED)).rejects.toMatchObject({
      reason: 'fetch_blocked',
    });
    expect(session.identity.state).toBe('cooling');
  });

  it('stamps the identity as used when the page carries no token', async () => {
    const session = createTestSession('amazon_in');
    session.request = async () => reply(NO_TOKEN);
    session.identity.lastRequestAt = 1;

    await expect(amazonLocationCookie(session, '122002', SEED)).resolves.toBeUndefined();
    // The stamp is what moves the identity to the back of the queue.
    expect(session.identity.lastRequestAt).toBeGreaterThan(1);
  });

  it('still mints the cookie on a clean page', async () => {
    const session = createTestSession('amazon_in');
    const posts: string[] = [];
    session.request = async (url: string, options: SessionRequestOptions) => {
      if (options.method === 'POST') {
        posts.push(url);
        return reply('{}');
      }
      return reply(WITH_TOKEN);
    };
    session.cookieHeaderFor = () => 'session-id=1; lc-acbin=en_IN';

    await expect(amazonLocationCookie(session, '122003', SEED)).resolves.toBe(
      'session-id=1; lc-acbin=en_IN',
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('/glow/address-change');
  });

  it('still degrades to no location for a failure that is not a block', async () => {
    const session = createTestSession('amazon_in');
    session.request = async (_url: string, options: SessionRequestOptions) => {
      if (options.method === 'POST') {
        throw new CheckError('fetch_timeout', 'address-change timed out');
      }
      return reply(WITH_TOKEN);
    };

    await expect(amazonLocationCookie(session, '122004', SEED)).resolves.toBeUndefined();
  });
});
