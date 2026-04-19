import { obsidianRequest } from "../utils/http";

export interface ServerCapabilities {
	claimed: boolean;
	authMode: "env" | "claim" | "unclaimed";
	attachments: boolean;
	snapshots: boolean;
	serverVersion: string;
	minPluginVersion: string | null;
	recommendedPluginVersion: string | null;
	minSchemaVersion: number | null;
	maxSchemaVersion: number | null;
	migrationRequired: boolean;
	updateProvider: "github" | "gitlab" | "unknown" | null;
	updateRepoUrl: string | null;
	updateRepoBranch?: string | null;
}

export async function fetchServerCapabilities(host: string): Promise<ServerCapabilities> {
	const base = host.replace(/\/$/, "");
	const res = await obsidianRequest({
		url: `${base}/api/capabilities`,
		method: "GET",
	});
	if (res.status !== 200) {
		throw new Error(`capabilities request failed (${res.status})`);
	}
	return res.json as ServerCapabilities;
}
