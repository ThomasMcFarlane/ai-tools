import { describe, expect, it } from 'vitest';
import { bnn } from '../src/core/adapters/bnn.js';
import { fixtureCtx, loadFixture } from './helpers/fixture.js';

const ctx = fixtureCtx(bnn);
const URL = 'https://www.bnn.in.th/en/p?q=ddr5+32gb';

describe('bnn adapter', () => {
  it('builds search URLs', () => {
    expect(bnn.searchUrl('ddr5 32gb', {})).toBe(URL);
    expect(bnn.searchUrl('ddr5 32gb', { page: 2 })).toBe(`${URL}&page=2`);
  });

  it('uses the user-browser mode because Cloudflare challenges every automated client', () => {
    expect(bnn.defaultMode).toBe('user-browser');
    expect(bnn.searchScript).toContain('html:');
    expect(bnn.listingScript).toContain('location.href');
  });

  it('flags the real Cloudflare challenge page as a block', () => {
    const snap = loadFixture('bnn', 'blocked', { url: URL, mode: 'headless' });
    expect(bnn.detectBlock(snap)).toBe('Cloudflare challenge page');
  });

  it('flags the challenge from a plain HTTP response too', () => {
    const snap = loadFixture('bnn', 'blocked', { url: URL, mode: 'http' });
    expect(bnn.detectBlock(snap)).toBe('Cloudflare challenge page');
  });

  it('does not flag a normal page', () => {
    const snap = loadFixture('bnn', 'blocked', { url: URL });
    const page = {
      ...snap,
      html: '<html><head><title>Banana IT</title></head><body>ok</body></html>',
    };
    expect(bnn.detectBlock(page)).toBeNull();
  });

  it('parses no hits from the challenge page', () => {
    const snap = loadFixture('bnn', 'blocked', { url: URL });
    expect(bnn.parseSearch(snap, ctx)).toEqual([]);
  });

  it('matches its own URLs only', () => {
    expect(bnn.matchesUrl('https://www.bnn.in.th/en/p/ram')).toBe(true);
    expect(bnn.matchesUrl('https://bnn.in.th/th/p/ram')).toBe(true);
    expect(bnn.matchesUrl('https://example.com/en/p/ram')).toBe(false);
  });
});
