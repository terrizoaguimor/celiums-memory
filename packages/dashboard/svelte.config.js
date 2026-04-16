import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter({ out: 'build' }),
		csrf: {
			// OAuth and MCP routes handle their own auth (Bearer tokens, not cookies)
			// They are excluded from cookie-based auth in hooks.server.ts
			// SvelteKit CSRF only applies to form actions which use cookies
			// The OAuth POST comes from our own form served at /oauth/authorize
			// which is same-origin (served from the tunnel URL)
			checkOrigin: false
		}
	}
};

export default config;
