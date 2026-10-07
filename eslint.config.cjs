// ESLint for claude-ext-common itself; the shared rules live in eslint.base.cjs.
const { baseConfig, htmlGroups } = require('./eslint.base.cjs');

module.exports = baseConfig({
	root: __dirname,
	groups: [
		// The runtime files, which the extensions load into one scope together (in this order).
		{
			name: 'common runtime',
			files: [
				'log/logger.js',
				'i18n/en.js', 'i18n/fr.js', 'i18n/de.js', 'i18n/hi.js', 'i18n/id.js',
				'i18n/it.js', 'i18n/ja.js', 'i18n/ko.js', 'i18n/pt-BR.js', 'i18n/es.js',
				'i18n/i18n-core.js',
				'i18n/account-locale-watcher.js',
				'claude/page.js',
				'net/bard-schema.js',
				'net/net.js',
				'ext/bridge-isolated.js',
				'ui/components.js',
				'ui/cards.js',
			],
		},
		...htmlGroups(__dirname, ['log/viewer.html']),
	],
});
