# claude-ext-common

Shared code for the claude.ai browser extensions
[Claude Toolbox (QoL)](https://github.com/lugia19/Claude-QoL) and
[Claude Usage Tracker](https://github.com/lugia19/Claude-Usage-Extension).
Each extension includes this repo as a git submodule at `common/`:

```bash
git clone --recurse-submodules <extension repo>
# or, in an existing clone:
git submodule update --init
```

There is no bundler. Every file is a plain script listed directly in the extension's manifest
(`common/...` paths), so `web-ext build` picks it up like any other file.

## Contents

| Path | World | What |
| --- | --- | --- |
| `i18n/i18n-core.js` | any | `localize`, `translate`, `currentLocale`, `normalizeLocale`, `fmtNum`, the shared language override and account locale cache |
| `i18n/account-locale-watcher.js` | MAIN | Records the account language from `PUT /api/account_profile`. IIFE, safe for every extension to load |
| `i18n/<lang>.js` | any | Tables for the `shared.*` keys used by the files here |
| `claude/page.js` | ISOLATED (+ MAIN, one extension) | `getActiveOrgId`, `getConversationId`, `getIncognitoConversationId`, `isIncognito`, `getProjectId`, and page predicates (`isHomePage`, `isChatPage`, `isProjectPage`, `isCodePage`, `isCoworkPage`). URL, cookie and sessionStorage only, never the DOM |
| `net/net.js` | any (MAIN-safe) | `globalThis.ClaudeExtNet`: fetch arguments (`getFetchUrl`, `getFetchMethod`), API URLs (`getApiIds`, `isCompletionUrl`), rebuilt responses (`sanitizedHeaders`, `jsonResponse`), request bodies (`readJsonRequestBody`, `withJsonRequestBody`, `isGzipRequest`, `isGzipBytes`, `gunzipBytes`), SSE (`createSseSplitter`, `readSseEvents`) and `isKillSwitchOn`. Append-only, see Rules |
| `ui/components.js` | ISOLATED | claude.ai-styled UI kit: `CLAUDE_CLASSES`, `ClaudeModal`, alert/confirm/prompt helpers, `createClaude*` controls, `createLanguageSelect`, tooltips, `isMobileLayout` |
| `ui/cards.js` | ISOLATED | `FloatingCard`, `makeDraggable`, `initNotificationCards` (version-update and rate-reminder cards) |
| `assets/` | - | Images used by the cards. List them in `web_accessible_resources`. |
| `scripts/` | - | Dev tooling, see below. Exclude it from builds (`--ignore-files "common/scripts/**"`). |

Load order: the `i18n/<lang>.js` tables, then the extension's own tables, then `i18n/i18n-core.js`,
then `claude/page.js`, then `ui/components.js`, then `ui/cards.js`.

## Rules

These exist because two extensions load this code into the same page.

- **Each extension has its own ISOLATED world**, so globals declared there can't collide. The files
  here declare plain globals (`ClaudeModal`, `localize`, ...), and extensions call them directly.
- **The MAIN world is shared** between every extension and the page. A top-level `const`, `let` or
  `class` declared by two extensions throws `SyntaxError: Identifier has already been declared`, and
  two versions of this repo would share one set of globals. So only **one** extension (the Toolbox)
  may load global-declaring files from here into MAIN. Anything that both extensions need in MAIN
  must be an IIFE with no top-level bindings.
- **`net/net.js` is append-only.** Both extensions load it into MAIN, and it fills
  `globalThis.ClaudeExtNet` member by member with `??=`, so whichever copy loads first provides each
  member - possibly an older version than yours. Never change what a published member does or
  returns; add a member with a new name instead.
- **The page DOM is shared too.** Don't inject a stylesheet with a fixed id or shared class names
  whose rules could differ between versions. Style with claude.ai's own Tailwind/CDS classes and
  inline styles.
- **Never locate claude.ai elements by visible text, `aria-label`, `alt` or `title`**: claude.ai
  localizes its UI. Use `data-testid`, `data-cds`, or structure.

## How the two extensions coordinate

Beyond sharing this code, the extensions rely on each other's behaviour in two places. Keep both
sides in sync when changing either:

- **Claude QoL marks `<html>` with `data-claude-qol-installed`.** The tracker reads it to hide its
  "get Claude QoL" links, promo badges and the matching settings toggle.
- **The title-area claim.** The tracker keeps its stats line's full width claimed in the chat title
  group and lets it overflow; QoL's header button bar watches for header overflow and collapses its
  buttons into a menu to make room. The tracker never reads QoL's classes: it measures what is in
  the header band and only falls back to a strip below the header after a grace period.

## Localization

All tables merge into `globalThis.CLAUDE_EXT_I18N`:

```js
Object.assign((globalThis.CLAUDE_EXT_I18N ??= {})['en'] ??= {}, { 'feature.key': 'Text with {name}' });
```

`shared.*` keys belong to this repo; extensions must not define them. Every key goes into all 10
tables (en, fr, de, hi, id, it, ja, ko, pt-BR, es), with `en` as the source of truth.

The language is resolved synchronously from claude.ai's localStorage, which every extension on the
page shares, so they always agree:

1. `claude_ext_language`: the user's override, set by any extension's language picker via
   `setLanguageOverride()`
2. `claude_ext_locale_cache`: the claude.ai account locale. Call `refreshAccountLocale()` once per
   page load from one ISOLATED script: it refetches once the entry is older than 24h, and claims
   the refresh first so other worlds and extensions don't repeat it. Load
   `account-locale-watcher.js` in MAIN so a language change applies on claude.ai's reload.
3. `navigator.language`

A language change reloads the page. Contexts without claude.ai's localStorage (popup, background)
can't resolve the language: have the content script store `currentLocale()` for them, then call
`pinLocale(locale)` before using `localize()`, or `translate(locale, key, vars)` directly.
`createLanguageSelect()` builds the picker; save its value with `setLanguageOverride()`.
`i18n-core.js` also publishes its API on `globalThis`, so an ES-module background can load it with a
side-effect `import`.

## Scripts

All run from the extension repo's root:

- `node common/scripts/mirror-debug.js [--watch]`: copies the repo into `debug/<target>/` for every
  `manifest_<target>.json`, each with its own `manifest.json`, so all targets can be loaded unpacked
  at once. Real copies: Chrome refuses to serve symlinked files.
- `node common/scripts/check-i18n.js [--tables <dir>]... [--src <dir>]...`: missing, extra and
  undefined keys, placeholder mismatches, and extension tables defining `shared.*` keys. `--src`
  takes directories or files. Defaults to `--tables content/i18n --src content`.
- `bash common/scripts/poll-codex.sh <pr> [--trigger|--read] [--message=...]` and
  `bash common/scripts/codex-react.sh <pr> <PRRC_id> <up|down|none>`: the Codex PR review loop.

## License

GPL-3.0, like both extensions.
