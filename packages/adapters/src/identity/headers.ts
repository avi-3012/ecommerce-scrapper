import { HeaderGenerator } from 'header-generator';
import type { Identity, IdentityBrowser, IdentityDevice, IdentityOs } from './types.js';
import { ACCEPT_ENCODING } from '../fetch/bytes.js';

/**
 * Header generation + the consistency assertion that guards it.
 *
 * Generated ONCE per identity. `header-generator` (the library got-scraping
 * uses internally) emits a real browser's header set in a real browser's ORDER,
 * with `sec-ch-ua` / `sec-ch-ua-platform` / `sec-ch-ua-mobile` agreeing with the
 * User-Agent. We then freeze the result: nothing rotates for the life of the
 * identity.
 *
 * Chromium family only, because got-scraping impersonates Chromium at the TLS
 * layer. A Firefox UA over a Chromium handshake is the exact contradiction this
 * layer exists to avoid, so the assertion below refuses to let one be created.
 */

/**
 * `accept-encoding` is pinned rather than taken from the generator. Two reasons:
 * the existing byte-metering path fetches the COMPRESSED body and decodes it
 * itself, and `decompressBody` is deliberately total over exactly this set — a
 * generated `zstd` would leave it guessing. Pinned at creation and stored, so it
 * is still replayed verbatim like every other header.
 */
const PINNED_ACCEPT_ENCODING = ACCEPT_ENCODING;

export interface IdentitySpec {
  browser: IdentityBrowser;
  os: IdentityOs;
  device: IdentityDevice;
}

/**
 * Combinations that describe a device that actually exists AND whose pages this
 * codebase can read.
 *
 * Desktop only, deliberately. A mobile User-Agent makes Amazon serve its mobile
 * layout — `apex_mobile`, `apex_offerDisplay_single_mobile` — and the parsers
 * are written against the desktop buy box (`corePriceDisplay_desktop_feature_div`,
 * `apex_desktop`). Adding android/mobile personas here silently broke roughly
 * one Amazon check in four: a full, legitimate, 1.7 MB product page with no
 * extractable price, indistinguishable from throttling until the response body
 * was captured and read.
 *
 * The pre-migration fetch pinned `devices: ['desktop']` for exactly this reason.
 * Mobile can come back the day the parsers grow mobile selectors — until then a
 * persona whose pages we cannot read is not diversity, it is a failure rate.
 */
export const IDENTITY_SPECS: readonly IdentitySpec[] = [
  { browser: 'chrome', os: 'windows', device: 'desktop' },
  { browser: 'chrome', os: 'macos', device: 'desktop' },
  { browser: 'edge', os: 'windows', device: 'desktop' },
];

/** Whether an existing identity still matches a supported spec. */
export function isSupportedSpec(spec: IdentitySpec): boolean {
  return IDENTITY_SPECS.some(
    (s) => s.browser === spec.browser && s.os === spec.os && s.device === spec.device,
  );
}

/**
 * How many draws to take before giving up on a spec.
 *
 * The generator samples from a distribution of real browsers, and asking for
 * "chrome" can legitimately hand back a Chromium sibling — a Brave-branded
 * `sec-ch-ua` over a `Chrome/144` User-Agent, say. Internally that IS a real
 * browser; it just isn't the one this identity says it is, and the identity's
 * whole value is that it says one thing and means it. So we redraw until the
 * brand matches the declared family rather than relax the assertion.
 */
const MAX_GENERATION_ATTEMPTS = 40;

export function generateHeaders(spec: IdentitySpec): Record<string, string> {
  const generator = new HeaderGenerator({
    browsers: [{ name: spec.browser, minVersion: 120 }],
    devices: [spec.device],
    operatingSystems: [spec.os],
    locales: ['en-IN', 'en'],
    httpVersion: '2',
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const generated = generator.getHeaders() as Record<string, string>;
    // Rebuild in the generator's own key order so the pinned encoding keeps its
    // slot rather than being appended at the end.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(generated)) {
      headers[key.toLowerCase()] =
        key.toLowerCase() === 'accept-encoding' ? PINNED_ACCEPT_ENCODING : value;
    }
    if (!headers['accept-encoding']) headers['accept-encoding'] = PINNED_ACCEPT_ENCODING;
    try {
      assertIdentityConsistent({ ...spec, headers });
      return headers;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Could not generate a consistent ${spec.browser}/${spec.os}/${spec.device} header set in ` +
      `${MAX_GENERATION_ATTEMPTS} attempts. Last mismatch: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/** The brand `sec-ch-ua` must name for a given browser family. */
const BRAND: Record<IdentityBrowser, string> = {
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
};

const PLATFORM: Record<IdentityOs, string> = {
  windows: 'Windows',
  macos: 'macOS',
  android: 'Android',
};

/**
 * Refuse to admit an internally contradictory identity into the pool. Called at
 * creation AND on load, so a hand-edited store file can't quietly poison the
 * pool with a persona that contradicts the TLS handshake underneath it.
 *
 * Throws with a specific message rather than returning false: a contradictory
 * identity is a bug, and the pool must not paper over it.
 */
export function assertIdentityConsistent(identity: {
  browser: IdentityBrowser;
  os: IdentityOs;
  device: IdentityDevice;
  headers: Record<string, string>;
}): void {
  const { browser, os, device, headers } = identity;
  const where = `identity ${browser}/${os}/${device}`;
  const ua = headers['user-agent'];
  if (!ua) throw new Error(`${where}: no user-agent header`);

  // 1. TLS family. got-scraping impersonates Chromium; both Chrome and Edge are
  //    Chromium, and both must say so in the UA.
  if (!/Chrome\/\d+/.test(ua)) {
    throw new Error(`${where}: user-agent is not Chromium-family, but the TLS profile is: ${ua}`);
  }
  const isEdgeUa = /\bEdg\/\d+/.test(ua);
  if (browser === 'edge' && !isEdgeUa)
    throw new Error(`${where}: edge identity without Edg/ in UA`);
  if (browser === 'chrome' && isEdgeUa)
    throw new Error(`${where}: chrome identity with Edg/ in UA`);

  // 2. sec-ch-ua must name the same brand and the same major version as the UA.
  const secChUa = headers['sec-ch-ua'];
  if (!secChUa) throw new Error(`${where}: no sec-ch-ua header`);
  if (!secChUa.includes(BRAND[browser])) {
    throw new Error(`${where}: sec-ch-ua "${secChUa}" does not name ${BRAND[browser]}`);
  }
  const uaMajor = (isEdgeUa ? ua.match(/Edg\/(\d+)/) : ua.match(/Chrome\/(\d+)/))?.[1];
  const brandMajor = secChUa.match(
    new RegExp(`"${BRAND[browser].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}";v="(\\d+)"`),
  )?.[1];
  if (uaMajor && brandMajor && uaMajor !== brandMajor) {
    throw new Error(`${where}: UA major ${uaMajor} ≠ sec-ch-ua major ${brandMajor}`);
  }

  // 3. Platform hints must agree with the OS and the device form factor.
  const platform = headers['sec-ch-ua-platform'];
  if (platform && platform.replace(/"/g, '') !== PLATFORM[os]) {
    throw new Error(`${where}: sec-ch-ua-platform ${platform} ≠ ${PLATFORM[os]}`);
  }
  const mobileHint = headers['sec-ch-ua-mobile'];
  const expectedMobile = device === 'mobile' ? '?1' : '?0';
  if (mobileHint && mobileHint !== expectedMobile) {
    throw new Error(`${where}: sec-ch-ua-mobile ${mobileHint} ≠ ${expectedMobile}`);
  }
  if (device === 'mobile' && !/Mobile/.test(ua)) {
    throw new Error(`${where}: mobile identity without "Mobile" in UA`);
  }
  if (device === 'desktop' && /Mobile/.test(ua)) {
    throw new Error(`${where}: desktop identity with "Mobile" in UA`);
  }

  // 4. India-resident pool: the locale must say so, and it must never rotate.
  const language = headers['accept-language'];
  if (!language || !language.startsWith('en-IN')) {
    throw new Error(`${where}: accept-language "${language ?? ''}" is not en-IN-first`);
  }
}

/** The identity's User-Agent — the one place anything outside should read it. */
export function userAgentOf(identity: Pick<Identity, 'headers'>): string {
  return identity.headers['user-agent'] ?? '';
}
