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
| `i18n/<lang>.js` | any | Tables for the `shared.*` keys used by the files here |
| `ui/components.js` | ISOLATED | claude.ai-styled UI kit: `CLAUDE_CLASSES`, `ClaudeModal`, alert/confirm/prompt helpers, `createClaude*` controls, tooltips, `isMobileLayout` |
| `ui/cards.js` | ISOLATED | `FloatingCard`, `makeDraggable`, `initNotificationCards` (version-update and rate-reminder cards) |
| `assets/` | - | Images used by the cards. List them in `web_accessible_resources`. |
| `scripts/` | - | Dev tooling, see below. Exclude it from builds (`--ignore-files "common/scripts/**"`). |

Load order: the `i18n/<lang>.js` tables, then the extension's own tables, then `i18n/i18n-core.js`,
then `ui/components.js`, then `ui/cards.js`.

## Rules

These exist because two extensions load this code into the same page.

- **Each extension has its own ISOLATED world**, so globals declared there can't collide. The files
  here declare plain globals (`ClaudeModal`, `localize`, ...), and extensions call them directly.
- **The MAIN world is shared** between every extension and the page. A top-level `const`, `let` or
  `class` declared by two extensions throws `SyntaxError: Identifier has already been declared`, and
  two versions of this repo would share one set of globals. So only **one** extension (the Toolbox)
  may load global-declaring files from here into MAIN. Anything that both extensions need in MAIN
  must be an IIFE with no top-level bindings.
- **The page DOM is shared too.** Don't inject a stylesheet with a fixed id or shared class names
  whose rules could differ between versions. Style with claude.ai's own Tailwind/CDS classes and
  inline styles.
- **Never locate claude.ai elements by visible text, `aria-label`, `alt` or `title`**: claude.ai
  localizes its UI. Use `data-testid`, `data-cds`, or structure.

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
2. `claude_ext_locale_cache`: the claude.ai account locale. `refreshAccountLocale()` refetches it
   once it is older than 24h; call `writeAccountLocale()` with the body of an intercepted
   `PUT /api/account_profile` so a language change applies on the next load.
3. `navigator.language`

A language change reloads the page. Contexts without claude.ai's localStorage (popup, background)
should use `translate(locale, key, vars)` with a locale the content script stored for them.
`i18n-core.js` also publishes its API on `globalThis`, so an ES-module background can load it with a
side-effect `import`.

## Scripts

All run from the extension repo's root:

- `node common/scripts/mirror-debug.js [--watch]`: copies the repo into `debug/<target>/` for every
  `manifest_<target>.json`, each with its own `manifest.json`, so all targets can be loaded unpacked
  at once. Real copies: Chrome refuses to serve symlinked files.
- `node common/scripts/check-i18n.js [--tables <dir>]... [--src <dir>]...`: missing, extra and
  undefined keys, placeholder mismatches, and extension tables defining `shared.*` keys. Defaults
  to `--tables content/i18n --src content`.
- `bash common/scripts/poll-codex.sh <pr> [--trigger|--read] [--message=...]` and
  `bash common/scripts/codex-react.sh <pr> <PRRC_id> <up|down|none>`: the Codex PR review loop.

## License

GPL-3.0, like both extensions.
