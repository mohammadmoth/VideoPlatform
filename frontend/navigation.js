(function (root) {
    'use strict';
    function libraryReturn(saved, origin) {
        try {
            const candidate = new URL(saved?.url || '', origin);
            if (candidate.origin === origin && candidate.pathname === '/library.html') {
                return candidate.pathname + candidate.search + candidate.hash;
            }
        } catch {}
        return '/library.html?master=true';
    }
    function isLibraryReferrer(referrer, origin) {
        try {
            const prior = new URL(referrer);
            return prior.origin === origin && prior.pathname === '/library.html';
        } catch { return false; }
    }
    function playerReturn(saved, referrer, origin) {
        return isLibraryReferrer(referrer, origin) ? libraryReturn(saved, origin) : '/library.html?master=true';
    }
    function canGoBack(referrer, origin, state) {
        return isLibraryReferrer(referrer, origin) && state?.videoPlatform === 'player';
    }
    const api = { libraryReturn, playerReturn, canGoBack };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.VideoNavigation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
