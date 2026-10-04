import { describe, expect, it, vi } from 'vitest';
import { gotScraping } from 'got-scraping';
import { CheckError } from '../errors.js';
import { createTestSession } from './testing.js';

vi.mock('got-scraping', () => ({ gotScraping: vi.fn() }));
const mockedGot = vi.mocked(gotScraping);

/** A session ready to navigate now: the test rig's warm-up counts as a request. */
const fresh = () => {
  const ready = createTestSession('amazon_in');
  ready.identity.lastRequestAt = null;
  return ready;
};

const reply = (statusCode: number, body: string) =>
  ({
    statusCode,
    body,
    rawBody: Buffer.from(body),
    headers: { 'content-type': 'text/html' },
    url: 'https://www.amazon.in/s?k=hp+victus',
  }) as never;

describe('approaching a product through a search', () => {
  it('ends the check when the search page is a block, with the identity cooling', async () => {
    // As on 4 Oct, 07:02:01: Amazon's 503 page for the search. The product
    // fetch must not follow with the identity it just refused.
    const session = fresh();
    mockedGot.mockResolvedValue(reply(503, '<html>Service Unavailable</html>'));

    const approach = session.approachViaSearch('amazon.in', 'hp victus');
    await expect(approach).rejects.toBeInstanceOf(CheckError);
    await expect(approach).rejects.toMatchObject({ reason: 'fetch_blocked' });
    expect(session.identity.state).toBe('cooling');
  });

  it('carries on to the product when the search merely fails', async () => {
    const session = fresh();
    // A connection that fails outright. (No mockReset between these tests: with
    // it, vitest reported this caught rejection as the test's own failure.)
    mockedGot.mockImplementation((async () => {
      throw new Error('socket closed');
    }) as never);

    await expect(session.approachViaSearch('amazon.in', 'hp victus')).resolves.toBe(false);
    expect(session.identity.state).not.toBe('cooling');
  });

  it('arrives at the product as a click from the results', async () => {
    const session = fresh();
    mockedGot.mockResolvedValue(reply(200, '<html><title>Amazon.in : hp victus</title></html>'));

    await expect(session.approachViaSearch('amazon.in', 'hp victus')).resolves.toBe(true);
    expect(session.identity.lastUrlBySite['amazon.in']).toContain('/s?k=');
  });
});
