import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CustomProvider } from '../../src/core/proxy/providers/CustomProvider.js';

const PROXIES = [
  'http://user:pass@proxy1.example.com:8080',
  'http://user:pass@proxy2.example.com:8080',
  'http://user:pass@proxy3.example.com:8080',
];

describe('CustomProvider', () => {
  it('round-robins through proxies', () => {
    const p = new CustomProvider(PROXIES, { strategy: 'round-robin' });
    assert.equal(p.getProxy().host, 'proxy1.example.com');
    assert.equal(p.getProxy().host, 'proxy2.example.com');
    assert.equal(p.getProxy().host, 'proxy3.example.com');
    assert.equal(p.getProxy().host, 'proxy1.example.com'); // wraps
  });

  it('normalises string proxy URLs', () => {
    const p = new CustomProvider(['http://u:pw@1.2.3.4:3128']);
    const proxy = p.getProxy();
    assert.equal(proxy.host, '1.2.3.4');
    assert.equal(proxy.port, 3128);
    assert.equal(proxy.username, 'u');
    assert.equal(proxy.password, 'pw');
    assert.equal(proxy.protocol, 'http');
  });

  it('throws when list is empty', () => {
    const p = new CustomProvider([]);
    assert.throws(() => p.getProxy(), /No custom proxies/);
  });

  it('supports random strategy without throwing', () => {
    const p = new CustomProvider(PROXIES, { strategy: 'random' });
    const proxy = p.getProxy();
    assert.ok(PROXIES.some((u) => u.includes(proxy.host)));
  });
});
