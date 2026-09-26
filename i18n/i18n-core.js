// i18n-core.js (claude-ext-common)
// UI localization shared by the claude.ai extensions. Classic script, no IIFE: everything below is a
// global of the loading world. Load it after the string tables, which register themselves with
//   Object.assign((globalThis.CLAUDE_EXT_I18N ??= {})['<lang>'] ??= {}, { ... })
// so common/i18n/<lang>.js and each extension's own tables merge into one lookup table per language.
//
// The language is resolved synchronously from claude.ai's localStorage. Every extension on the page
// shares that origin, so they all see the same keys and always agree on the language:
//   1. claude_ext_language      - user override, set from any extension's language picker
//   2. claude_ext_locale_cache  - the claude.ai account locale, see refreshAccountLocale()
//   3. navigator.language
// A language change always reloads the page; nothing re-renders live.
//
// Contexts without claude.ai's localStorage (an extension's popup or background) can't resolve the
// language themselves: have a content script store currentLocale() somewhere they can read, and
// call translate(locale, key, vars) there instead of localize().

const I18N_LOCALES = ['en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-BR', 'es'];

// Deliberately untranslated: each language is shown in its own script.
const LANGUAGE_NATIVE_NAMES = {
	'en': 'English',
	'fr': 'Français',
	'de': 'Deutsch',
	'hi': 'हिन्दी',
	'id': 'Bahasa Indonesia',
	'it': 'Italiano',
	'ja': '日本語',
	'ko': '한국어',
	'pt-BR': 'Português (Brasil)',
	'es': 'Español',
};

const I18N_OVERRIDE_KEY = 'claude_ext_language';
const ACCOUNT_LOCALE_CACHE_KEY = 'claude_ext_locale_cache';
const ACCOUNT_LOCALE_TTL = 24 * 60 * 60 * 1000;

// The locales claude.ai itself offers, in the form /api/account_profile reports them.
const ACCOUNT_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419', 'es-ES', 'it-IT', 'hi-IN', 'pt-BR', 'id-ID'];

// Map any language tag (en-US, es-419, pt, ...) to one of I18N_LOCALES. Falls back to 'en'.
function normalizeLocale(raw) {
	if (!raw || typeof raw !== 'string') return 'en';
	const lower = raw.toLowerCase().trim();
	const exact = I18N_LOCALES.find(l => l.toLowerCase() === lower);
	if (exact) return exact;
	const base = lower.split('-')[0];
	if (base === 'pt') return 'pt-BR';
	return I18N_LOCALES.find(l => l === base) || 'en';
}

function _readAccountLocaleCache() {
	try {
		const cached = JSON.parse(localStorage.getItem(ACCOUNT_LOCALE_CACHE_KEY));
		if (cached && ACCOUNT_LOCALES.includes(cached.locale)) return cached;
	} catch (e) { /* no storage, or bad JSON */ }
	return null;
}

// Record the account locale, e.g. from the body of a PUT /api/account_profile. Ignores anything
// that isn't a locale claude.ai offers.
function writeAccountLocale(locale) {
	if (!ACCOUNT_LOCALES.includes(locale)) return;
	try {
		localStorage.setItem(ACCOUNT_LOCALE_CACHE_KEY, JSON.stringify({
			locale,
			expiry: Date.now() + ACCOUNT_LOCALE_TTL
		}));
	} catch (e) { /* storage blocked */ }
}

// Refetch the account locale once the cache has expired. Deliberately not on every load: right
// after a language change the GET can briefly still return the old locale, while the PUT watcher
// has already written the new one.
async function refreshAccountLocale() {
	const cached = _readAccountLocaleCache();
	if (cached && Date.now() < cached.expiry) return cached.locale;
	try {
		const response = await fetch('/api/account_profile');
		if (response.ok) {
			const data = await response.json();
			writeAccountLocale(data.locale);
			if (ACCOUNT_LOCALES.includes(data.locale)) return data.locale;
		}
	} catch (e) {
		console.error('Failed to fetch account locale:', e);
	}
	return accountLocale();
}

// The account locale in claude.ai's own form (en-US, ja-JP, ...), e.g. for completion requests.
// Unlike currentLocale() this ignores the extension language override.
function accountLocale() {
	const cached = _readAccountLocaleCache();
	if (cached) return cached.locale;
	return ACCOUNT_LOCALES.includes(navigator.language) ? navigator.language : 'en-US';
}

function getLanguageOverride() {
	try {
		return localStorage.getItem(I18N_OVERRIDE_KEY) || '';
	} catch (e) {
		return '';
	}
}

// '' clears the override (follow the account language). The caller reloads the page.
function setLanguageOverride(value) {
	try {
		if (value) localStorage.setItem(I18N_OVERRIDE_KEY, normalizeLocale(value));
		else localStorage.removeItem(I18N_OVERRIDE_KEY);
	} catch (e) { /* storage blocked - the account language stays in effect */ }
}

function _resolveLocale() {
	const override = getLanguageOverride();
	if (override) return normalizeLocale(override);
	// Expiry deliberately ignored: an expired entry is still a better guess than navigator.language,
	// and refreshAccountLocale() updates it for the next load.
	const cached = _readAccountLocaleCache();
	if (cached) return normalizeLocale(cached.locale);
	return normalizeLocale(globalThis.navigator?.language);
}

let _i18nLocale = null;

// Resolved on first use rather than at load, so a context without claude.ai's localStorage (a
// background script importing this file for translate()) never touches it.
function currentLocale() {
	return _i18nLocale ??= _resolveLocale();
}

/**
 * Look up a UI string for an explicit locale. Falls back to English, then to the key itself.
 * @param {string} locale - Any language tag, normalized with normalizeLocale()
 * @param {string} key - Dotted key, e.g. 'shared.cancel'
 * @param {Object} [vars] - Values for {name} placeholders
 */
function translate(locale, key, vars) {
	const tables = globalThis.CLAUDE_EXT_I18N || {};
	let str = tables[normalizeLocale(locale)]?.[key] ?? tables.en?.[key] ?? key;
	if (vars) {
		// Function replace, so a '$' in a value is never read as a replacement pattern.
		str = str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
	}
	return str;
}

// Look up a UI string in the current language.
function localize(key, vars) {
	return translate(currentLocale(), key, vars);
}

function fmtNum(n) {
	return Number(n).toLocaleString(currentLocale());
}

// Declarations above are only globals in a classic script. Publish them explicitly as well, so an
// ES module (a background service worker) can use this file through a side-effect import.
Object.assign(globalThis, {
	I18N_LOCALES, LANGUAGE_NATIVE_NAMES, ACCOUNT_LOCALES, normalizeLocale, writeAccountLocale,
	refreshAccountLocale, accountLocale, getLanguageOverride, setLanguageOverride, currentLocale,
	translate, localize, fmtNum,
});
