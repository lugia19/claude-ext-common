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
| `log/logger.js` | any (MAIN: one extension) | `configureLogger({ app, prefix })`, `createLogger(sender)`: always-on logging to the console and the extension's own `chrome.storage.local.debug_logs` (last 1000 entries). In MAIN, entries are relayed to the same app's ISOLATED world |
| `log/viewer.html` | extension page | The debug-log viewer (filters, search, copy, clear). Open it with `openDebugLogs()` or in a tab; `?lang=` sets its language. List it and `log/viewer.js` in `web_accessible_resources` |
| `i18n/i18n-core.js` | any | `localize`, `translate`, `currentLocale`, `normalizeLocale`, `fmtNum`, the shared language override and account locale cache |
| `i18n/account-locale-watcher.js` | MAIN | Records the account language from `PUT /api/account_profile`. IIFE, safe for every extension to load |
| `i18n/<lang>.js` | any | Tables for the `shared.*` keys used by the files here |
| `claude/page.js` | ISOLATED (+ MAIN, one extension) | `getActiveOrgId`, `getConversationId`, `getIncognitoConversationId`, `isIncognito`, `getProjectId`, and page predicates (`isHomePage`, `isChatPage`, `isProjectPage`, `isCodePage`, `isCoworkPage`). URL, cookie and sessionStorage only, never the DOM |
| `net/net.js` | any (MAIN-safe) | `globalThis.ClaudeExtNet`: fetch arguments (`getFetchUrl`, `getFetchMethod`), API URLs (`getApiIds`, `isCompletionUrl`), rebuilt responses (`sanitizedHeaders`, `jsonResponse`), request bodies (`readJsonRequestBody`, `withJsonRequestBody`, `isGzipRequest`, `isGzipBytes`, `gunzipBytes`), SSE (`createSseSplitter`, `readSseEvents`), Connect-RPC frames (`splitConnectFrames`, `readConnectFrames`, `encodeConnectFrame`, and `rewriteConnectStream` / `rewriteConnectResponse` to patch a stream frame by frame and `inject` frames of our own), protobuf bodies (`readProtoRequestBody`, `withProtoRequestBody`, `protoResponse`), the bard API codec (`decodeBard`, `encodeBard`, need `net/bard-schema.js`; `decodeBard(type, bytes, { keepUnknown: true })` keeps fields the schema doesn't know in `$unknown`, so decode → edit → `encodeBard` is lossless) and `isKillSwitchOn`. Versioned, newest wins: see Rules |
| `ext/bridge-isolated.js`, `ext/bridge-main.js` | ISOLATED / MAIN (MAIN-safe) | `globalThis.ClaudeExtBridge`, one file per world with the same names: `sendBackgroundMessage(app, message)` (ISOLATED: `runtime.sendMessage` with retries; MAIN: through the app's ISOLATED world), `call(app, type, data)` (MAIN asks an ISOLATED handler) and `serve(app, { handlers, background })` (ISOLATED: answers MAIN, forwarding only allow-listed background message types). Load each in its own world (Chrome injects a given file once per page and `run_at`, across worlds, so one file at `document_start` in both would skip one of them), and load `serve()` at `document_start` if MAIN sends during page load. The MAIN half is versioned, newest wins: see Rules |
| `net/bard-schema.js` | any (MAIN-safe) | `globalThis.ClaudeExtBardSchema`: the bard API schema subset `decodeBard` reads (~100 KB). **Generated** by `scripts/bard/gen-schema.mjs`, never edited by hand. Load it wherever `decodeBard` is called. Versioned, newest wins: see Rules |
| `ui/components.js` | ISOLATED | claude.ai-styled UI kit: `CLAUDE_CLASSES`, `ClaudeModal`, alert/confirm/prompt helpers, `createClaude*` controls, `createLanguageSelect`, `openDebugLogs`, tooltips, `isMobileLayout` |
| `ui/cards.js` | ISOLATED | `FloatingCard`, `makeDraggable`, `initNotificationCards` (version-update and rate-reminder cards) |
| `assets/` | - | Images used by the cards. List them in `web_accessible_resources`. |
| `scripts/` | - | Dev tooling, see below. Exclude it from builds (`--ignore-files "common/scripts/**"`). |
| `eslint.base.cjs` | - | The ESLint config shared by all three repos, see Linting. Exclude it, `eslint.config.cjs` and `package*.json` from builds. |

Load order: `log/logger.js` (then the extension's `configureLogger` call), the `i18n/<lang>.js` tables, then the extension's own tables, then `i18n/i18n-core.js`,
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
- **`net/net.js` is versioned: the newest copy wins.** Both extensions load it into MAIN. Whatever
  the load order, the copy with the highest `VERSION` provides every member of
  `globalThis.ClaudeExtNet` (it replaces an older copy's members on the same object; an older copy
  loading later changes nothing). So **bump `VERSION` with every change to the file**, and keep
  members compatible with older callers - the other extension may be older than yours: fixes and
  new options are fine, removing a member or changing its parameters or result is not. Callers must
  look members up on the object at call time (`const net = ClaudeExtNet; net.x()`), never keep a
  member itself.
- **`ext/bridge-main.js` is versioned the same way as `net.js`** (`globalThis.ClaudeExtBridge`). Its
  ISOLATED counterpart's `serve()` allow-lists are the security boundary: page scripts share MAIN and can post bridge messages
  too, so list only the background message types and handlers the page side really needs.
- **`net/bard-schema.js` is versioned the same way**, as one table: the highest `VERSION` wins and an
  older copy loading later changes nothing. `gen-schema.mjs` bumps `VERSION` itself whenever the
  table changes; `decodeBard` looks the table up at call time.
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

## Linting

`eslint.base.cjs` is the one ESLint flat config for this repo and both extensions. Each repo's
`eslint.config.js` calls `baseConfig({ root, groups, libGlobals, modules, serviceWorker, ignores })` with
what's its own (see the file's header). Only extension code is linted: dev tooling (`scripts/`, `*.mjs`,
`*.cjs`, the configs) is left out. The rules: `@eslint/js` recommended, `no-undef`, and `no-unused-vars`
ignoring arguments, catch bindings and rest siblings, and, in plain scripts, top-level names (those
are shared with other files).

**Cross-file globals are derived, never declared.** No `/* global */` headers and no hand-kept lists.
Scripts that share a scope form a group: a `content_scripts` entry of a manifest (`manifestGroups`),
the `<script>` tags of an extension page (`htmlGroups`), an ES-module graph (`moduleGroup`, for a
module background: a side-effect-imported classic script only adds what it publishes on `globalThis`,
since its top-level declarations stay module-scoped), or a list by hand. Publishing is `globalThis.X =
…` or `Object.assign(globalThis, { … })` (also on `window`/`self`). Every file in a group is
parsed for what it declares at top level or assigns to `globalThis`/`window`/`self`, and each file may
use its group's names. A file in several groups (a helper in both MAIN and ISOLATED) gets only the
names all of them provide. Minified libraries aren't parsed: name their globals in `libGlobals`.

In this repo: `npm ci`, then `npx eslint .` (works in a standalone clone or in an extension's
`common/` submodule: `check-common.js` lets an ignored root `node_modules/` through, and web-ext
never packs it). The extensions resolve the base's dependencies from their own `node_modules`.

## Scripts

All run from the extension repo's root:

- `node common/scripts/mirror-debug.js [--watch]`: copies the repo into `debug/<target>/` for every
  `manifest_<target>.json`, each with its own `manifest.json`, so all targets can be loaded unpacked
  at once. Real copies: Chrome refuses to serve symlinked files.
- `node common/scripts/check-i18n.js [--tables <dir>]... [--src <dir>]...`: missing, extra and
  undefined keys, placeholder mismatches, and extension tables defining `shared.*` keys. `--src`
  takes directories or files. Defaults to `--tables content/i18n --src content`.
- `node common/scripts/check-common.js`: run first by each extension's `build.bat`, from the extension
  root, after checking the submodule out if it never was (the script lives in it). Stops the build
  unless `common/` is clean (untracked and ignored files count, except ignored files under
  `scripts/`, which no build packs), checked out at the commit the
  extension pins, and that commit matches common's `main` (by content: a merge commit past the pin
  is fine). A failed fetch stops it too.
- `node common/scripts/release.js <major|minor|patch|X.Y.Z> "<title>"`: write `update_patchnotes.txt`
  first. Bumps the three manifests, commits and pushes, tags `vX.Y.Z`, runs `build.bat` and creates a
  **draft** GitHub release (patch notes as the body, the three zips attached). Re-running the same
  command resumes. Nothing reaches the stores.
- `node common/scripts/publish.js <X.Y.Z> [--only=chrome,firefox,github]`: once the draft's zips are
  tested. After you type the version to confirm, submits the Chrome zip to the Chrome Web Store (API
  v2, service account) and the Firefox zip to AMO (listed, with the draft's notes), then publishes
  the GitHub release. Credentials live in `%USERPROFILE%\.claude-ext-publish.json`, never in a repo;
  the format is at the top of the script.
- `bash common/scripts/poll-codex.sh <pr> [--trigger|--read] [--message=...]` and
  `bash common/scripts/codex-react.sh <pr> <PRRC_id> <up|down|none>`: the Codex PR review loop.
- `scripts/bard/`: schema extraction, a schema snapshot and a traffic decoder for claude.ai's
  merged-experience Connect-RPC API, plus what we know about it. See its README. Re-extract the
  schema before changing anything that reads that API.

## License

GPL-3.0, like both extensions.
