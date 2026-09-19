'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { libraryReturn, playerReturn, canGoBack } = require('../frontend/navigation');

test('player return context accepts only the same-origin library and preserves browsing state', () => {
    const origin = 'http://screen.local:8080';
    assert.equal(libraryReturn({ url: '/library.html?master=true&collection=Show&section=Season+2#video-abc' }, origin),
        '/library.html?master=true&collection=Show&section=Season+2#video-abc');
    assert.equal(libraryReturn({ url: 'https://attacker.example/library.html?master=true' }, origin),
        '/library.html?master=true');
    assert.equal(libraryReturn({ url: '/not-library' }, origin), '/library.html?master=true');
    assert.equal(libraryReturn(null, origin), '/library.html?master=true');
    const stale = { url: '/library.html?master=true&collection=stale#video-old' };
    assert.equal(playerReturn(stale, '', origin), '/library.html?master=true');
    assert.equal(playerReturn(stale, `${origin}/library.html?master=true`, origin), stale.url);
});

test('Back uses browser history only for an application-owned library transition', () => {
    const origin = 'http://screen.local:8080';
    assert.equal(canGoBack(`${origin}/library.html?master=true`, origin, { videoPlatform: 'player' }), true);
    assert.equal(canGoBack(`${origin}/library.html`, origin, null), false);
    assert.equal(canGoBack('http://other.local/library.html', origin, { videoPlatform: 'player' }), false);
    assert.equal(canGoBack('', origin, { videoPlatform: 'player' }), false);
});
