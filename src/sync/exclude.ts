function normalizePrefix(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

function alwaysExcludedPrefixes(configDir: string): string[] {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	return [
		".trash/",
		`${normalizedConfigDir}/plugins/yaos/`,
	];
}

function alwaysExcludedConfigPrefixes(configDir: string): string[] {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	return [
		`${normalizedConfigDir}/workspace.json`,
		`${normalizedConfigDir}/workspaces.json`,
		`${normalizedConfigDir}/plugins/`,
	];
}

function normalizeConfiguredPrefixes(patterns: string[]): string[] {
	return patterns.map((prefix) => normalizePrefix(prefix));
}

function isConfigPathAllowed(
	normalizedPath: string,
	configDir: string,
	syncConfigDir: boolean,
	configIncludePatterns: string[],
): boolean {
	const normalizedConfigDir = normalizePrefix(configDir).replace(/\/$/, "");
	const configPrefix = `${normalizedConfigDir}/`;
	if (!normalizedPath.startsWith(configPrefix)) return true;
	if (!syncConfigDir) return false;
	for (const blockedPrefix of alwaysExcludedConfigPrefixes(configDir)) {
		if (normalizedPath.startsWith(blockedPrefix)) return false;
	}
	for (const allowedPrefix of normalizeConfiguredPrefixes(configIncludePatterns)) {
		if (normalizedPath.startsWith(allowedPrefix)) return true;
	}
	return false;
}

/**
 * Check if a vault-relative path should be excluded from sync.
 * Always excludes the current config directory and .trash/, plus any
 * user-configured prefixes.
 *
 * @param path - Vault-relative path (e.g. "templates/daily.md")
 * @param patterns - Parsed exclude prefixes (e.g. ["templates/", ".trash/"])
 * @param configDir - Obsidian config directory name
 * @returns true if the path matches any exclude pattern
 */
export function isExcluded(
	path: string,
	patterns: string[],
	configDir: string,
	syncConfigDir = false,
	configIncludePatterns: string[] = [],
): boolean {
	const normalizedPath = normalizePrefix(path);
	if (!isConfigPathAllowed(normalizedPath, configDir, syncConfigDir, configIncludePatterns)) {
		return true;
	}
	for (const prefix of alwaysExcludedPrefixes(configDir)) {
		if (normalizedPath.startsWith(prefix)) return true;
	}
	for (const prefix of patterns) {
		if (normalizedPath.startsWith(normalizePrefix(prefix))) return true;
	}
	return false;
}

/**
 * Parse the comma-separated excludePatterns setting into a list of
 * trimmed, non-empty prefixes.
 */
export function parseExcludePatterns(raw: string): string[] {
	return raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
