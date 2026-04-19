import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const rootDir = resolve(".");
const artifactPath = resolve(rootDir, "dist/release-assets/yaos-server.zip");
const tempDir = mkdtempSync(join(tmpdir(), "yaos-server-update-test-"));
const repoDir = join(tempDir, "repo");

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoDir,
		stdio: "inherit",
		...options,
	});
}

function read(relativePath) {
	return readFileSync(join(repoDir, relativePath), "utf8");
}

try {
	cpSync(resolve(rootDir, "server"), repoDir, { recursive: true });

	run("git", ["init", "-q"]);
	run("git", ["config", "user.name", "YAOS Local Test"]);
	run("git", ["config", "user.email", "local-test@yaos"]);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "baseline"]);

	const baselineVersion = read("src/version.ts");
	const baselineWrangler = read("wrangler.toml");
	const currentServerVersionMatch = baselineVersion.match(/SERVER_VERSION = "([^"]+)"/);
	if (!currentServerVersionMatch) {
		throw new Error("Unable to read current server version from src/version.ts");
	}
	const currentServerVersion = currentServerVersionMatch[1];

	writeFileSync(
		join(repoDir, "src/version.ts"),
		baselineVersion.replace(
			`SERVER_VERSION = "${currentServerVersion}"`,
			'SERVER_VERSION = "0.1.9"',
		),
	);
	writeFileSync(join(repoDir, "wrangler.toml"), `${baselineWrangler}\n# local-test-preserved\n`);
	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", "simulate older deployed server"]);

	run("node", ["scripts/update-from-release.mjs"], {
		env: {
			...process.env,
			YAOS_RELEASE_FILE: artifactPath,
		},
	});

	const updatedVersion = read("src/version.ts");
	if (updatedVersion !== baselineVersion) {
		throw new Error("Update test failed: src/version.ts was not restored from the artifact");
	}

	const updatedWrangler = read("wrangler.toml");
	if (!updatedWrangler.includes("# local-test-preserved")) {
		throw new Error("Update test failed: protected wrangler.toml changes were overwritten");
	}

	run("git", ["add", "-A"]);
	run("git", ["commit", "-qm", `yaos(server): update to ${currentServerVersion}`]);
	run("node", ["scripts/revert-last-update.mjs"]);

	const revertedVersion = read("src/version.ts");
	if (!revertedVersion.includes('SERVER_VERSION = "0.1.9"')) {
		throw new Error("Revert test failed: update-owned files were not restored");
	}

	const revertedWrangler = read("wrangler.toml");
	if (!revertedWrangler.includes("# local-test-preserved")) {
		throw new Error("Revert test failed: protected wrangler.toml changes were lost");
	}

	console.log("Local YAOS server update/revert smoke test passed.");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
