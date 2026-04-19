import { getServerByName } from "partyserver";
import * as Y from "yjs";
import { mapWithConcurrency } from "./concurrency";
import { sha256Hex } from "./hex";
import { ServerConfig, type StoredServerConfig } from "./config";
import {
	blobKey,
	createSnapshot,
	getSnapshotPayload,
	hasSnapshotForDay,
	listSnapshots,
	type SnapshotResult,
} from "./snapshot";
import { renderMobileSetupPage, renderRunningPage, renderSetupPage } from "./setupPage";
import {
	SERVER_MAX_SCHEMA_VERSION,
	SERVER_MIGRATION_REQUIRED,
	SERVER_MIN_PLUGIN_VERSION,
	SERVER_MIN_SCHEMA_VERSION,
	SERVER_RECOMMENDED_PLUGIN_VERSION,
	SERVER_VERSION,
} from "./version";
import { VaultSyncServer } from "./server";

const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXISTS_BATCH_LIMIT = 50;
const R2_HEAD_CONCURRENCY = 4;
const CORS_ALLOW_HEADERS = "Authorization, Content-Type";
const CORS_ALLOW_METHODS = "GET, POST, PUT, OPTIONS";
const CORS_EXPOSE_HEADERS = "X-YAOS-Snapshot-Day";
const LOG_PREFIX = "[yaos-sync:worker]";

interface Env {
	SYNC_TOKEN?: string;
	YAOS_CANONICAL_REPO?: string;
	YAOS_SYNC: DurableObjectNamespace<VaultSyncServer>;
	YAOS_CONFIG: DurableObjectNamespace;
	YAOS_BUCKET?: R2Bucket;
}

type AuthState =
	| { mode: "env"; claimed: true; envToken: string }
	| { mode: "claim"; claimed: true; tokenHash: string }
	| { mode: "unclaimed"; claimed: false };

type UpdateProvider = "github" | "gitlab" | "unknown";

type FatalAuthCode = "unauthorized" | "server_misconfigured" | "unclaimed" | "update_required";
const LEGACY_CLIENT_SCHEMA_VERSION = 1;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function withCors(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
	headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);

	const responseWithSocket = response as { webSocket?: WebSocket };
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		webSocket: responseWithSocket.webSocket,
	});
}

function corsPreflight(): Response {
	return withCors(new Response(null, { status: 204 }));
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function isValidHash(hash: string): boolean {
	return /^[0-9a-f]{64}$/.test(hash);
}

function getHttpAuthToken(req: Request): string | null {
	const auth = req.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	const token = auth.slice("Bearer ".length).trim();
	return token || null;
}

function getSocketAuthToken(req: Request): string | null {
	const headerToken = getHttpAuthToken(req);
	if (headerToken) return headerToken;
	return new URL(req.url).searchParams.get("token");
}

function parseClientSchemaVersion(url: URL): { version: number; source: "query" | "legacy-default" } | null {
	const raw = url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema");
	if (raw === null || raw.trim() === "") {
		return { version: LEGACY_CLIENT_SCHEMA_VERSION, source: "legacy-default" };
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) return null;
	return { version: parsed, source: "query" };
}

function parseSyncPath(pathname: string): { vaultId: string } | null {
	const directMatch = pathname.match(/^\/vault\/sync\/([^/]+)$/);
	if (directMatch) {
		const [, vaultId] = directMatch;
		if (vaultId) {
			return { vaultId: decodeURIComponent(vaultId) };
		}
	}
	return null;
}

function parseVaultPath(pathname: string): { vaultId: string; rest: string[] } | null {
	const parts = pathname.split("/").filter(Boolean);
	if (parts.length < 2 || parts[0] !== "vault") return null;
	const vaultId = parts[1];
	if (!vaultId) return null;
	return {
		vaultId: decodeURIComponent(vaultId),
		rest: parts.slice(2),
	};
}

function isWebSocketRequest(req: Request): boolean {
	return (req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
}

function rejectSocket(
	req: Request,
	code: FatalAuthCode,
	details: Record<string, unknown> = {},
): Response {
	if (!isWebSocketRequest(req)) {
		return json(
			{ error: code },
			code === "unauthorized"
				? 401
				: code === "update_required"
					? 426
					: 503,
		);
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	server.accept();
	const payload = JSON.stringify({ type: "error", code, ...details });
	// Send a plain JSON frame first for generic websocket clients/tests.
	server.send(payload);
	// y-partyserver clients consume string control messages via "__YPS:".
	// Send fatal auth payload through that channel so plugins can fail loudly.
	server.send(`__YPS:${payload}`);
	server.close(
		1008,
		code === "unauthorized"
			? "unauthorized"
			: code === "update_required"
				? "update required"
			: code === "unclaimed"
				? "server unclaimed"
				: "server misconfigured",
	);
	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

async function hashToken(token: string): Promise<string> {
	const bytes = new TextEncoder().encode(token);
	return sha256Hex(bytes);
}

function supportsBuckets(env: Env): boolean {
	return env.YAOS_BUCKET !== undefined;
}

function canonicalRepoForSetup(env: Env): string | undefined {
	const raw = env.YAOS_CANONICAL_REPO?.trim();
	if (!raw) return undefined;
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? raw : undefined;
}

async function getStoredServerConfig(env: Env): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/config");
	if (!res.ok) {
		throw new Error(`config fetch failed (${res.status})`);
	}
	return await res.json();
}

async function claimServerConfig(env: Env, tokenHash: string): Promise<boolean> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/claim", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ tokenHash }),
	});
	return res.ok;
}

async function setServerUpdateMetadata(env: Env, metadata: {
	updateProvider?: unknown;
	updateRepoUrl?: unknown;
	updateRepoBranch?: unknown;
}): Promise<StoredServerConfig> {
	const id = env.YAOS_CONFIG.idFromName("global-config");
	const stub = env.YAOS_CONFIG.get(id);
	const res = await stub.fetch("https://internal/__yaos/update-metadata", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(metadata),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`update metadata write failed (${res.status})${body ? `: ${body}` : ""}`);
	}
	const payload: { config?: StoredServerConfig } = await res.json();
	if (!payload?.config) {
		throw new Error("update metadata write failed (missing config)");
	}
	return payload.config;
}

async function getAuthState(env: Env): Promise<AuthState> {
	const envToken = env.SYNC_TOKEN?.trim();
	if (envToken) {
		return { mode: "env", claimed: true, envToken };
	}

	const config = await getStoredServerConfig(env);
	if (config.claimed && typeof config.tokenHash === "string" && config.tokenHash.length > 0) {
		return { mode: "claim", claimed: true, tokenHash: config.tokenHash };
	}

	return { mode: "unclaimed", claimed: false };
}

async function isAuthorized(
	state: AuthState,
	token: string | null,
): Promise<boolean> {
	if (!token) return false;
	if (state.mode === "env") {
		return token === state.envToken;
	}
	if (state.mode === "claim") {
		return (await hashToken(token)) === state.tokenHash;
	}
	return false;
}

function buildObsidianSetupUrl(host: string, token: string, vaultId?: string): string {
	const params = new URLSearchParams({
		action: "setup",
		host,
		token,
	});
	if (vaultId) {
		params.set("vaultId", vaultId);
	}
	return `obsidian://yaos?${params.toString()}`;
}

function getCapabilities(auth: AuthState, env: Env, config: StoredServerConfig | null = null): {
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
	updateProvider: UpdateProvider | null;
	updateRepoUrl: string | null;
	updateRepoBranch: string | null;
} {
	const bucketEnabled = supportsBuckets(env);
	return {
		claimed: auth.claimed,
		authMode: auth.mode,
		attachments: bucketEnabled,
		snapshots: bucketEnabled,
		serverVersion: SERVER_VERSION,
		minPluginVersion: SERVER_MIN_PLUGIN_VERSION,
		recommendedPluginVersion: SERVER_RECOMMENDED_PLUGIN_VERSION,
		minSchemaVersion: SERVER_MIN_SCHEMA_VERSION,
		maxSchemaVersion: SERVER_MAX_SCHEMA_VERSION,
		migrationRequired: SERVER_MIGRATION_REQUIRED,
		updateProvider: config?.updateProvider ?? null,
		updateRepoUrl: config?.updateRepoUrl ?? null,
		updateRepoBranch: config?.updateRepoBranch ?? null,
	};
}

async function recordVaultTrace(
	env: Env,
	vaultId: string,
	event: string,
	data: Record<string, unknown> = {},
): Promise<void> {
	try {
		const stub = await getServerByName(env.YAOS_SYNC, vaultId);
		await stub.fetch("https://internal/__yaos/trace", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ event, data }),
		});
	} catch (err) {
		console.warn(`${LOG_PREFIX} trace write failed:`, err);
	}
}

async function fetchVaultDocument(env: Env, vaultId: string): Promise<Uint8Array> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	const res = await stub.fetch("https://internal/__yaos/document");
	if (!res.ok) {
		throw new Error(`document fetch failed (${res.status})`);
	}
	return new Uint8Array(await res.arrayBuffer());
}

async function fetchVaultRoomMeta(env: Env, vaultId: string): Promise<{
	schemaVersion: number | null;
} | null> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	const res = await stub.fetch("https://internal/__yaos/meta");
	if (!res.ok) {
		throw new Error(`room meta fetch failed (${res.status})`);
	}
	const payload: {
		meta?: { schemaVersion?: unknown } | null;
	} = await res.json();
	const schemaVersion = payload?.meta?.schemaVersion;
	if (schemaVersion === null) {
		return { schemaVersion: null };
	}
	if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion >= 0) {
		return { schemaVersion };
	}
	return null;
}

async function fetchVaultSchemaVersion(env: Env, vaultId: string): Promise<number | null> {
	try {
		const meta = await fetchVaultRoomMeta(env, vaultId);
		if (meta) {
			return meta.schemaVersion;
		}
		const update = await fetchVaultDocument(env, vaultId);
		const doc = new Y.Doc();
		try {
			Y.applyUpdate(doc, update);
			const stored = doc.getMap("sys").get("schemaVersion");
			if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
				return stored;
			}
			return null;
		} finally {
			doc.destroy();
		}
	} catch (err) {
		console.warn(`${LOG_PREFIX} schema probe failed:`, err);
		return null;
	}
}

async function fetchVaultDebug(env: Env, vaultId: string): Promise<Response> {
	const stub = await getServerByName(env.YAOS_SYNC, vaultId);
	return await stub.fetch("https://internal/__yaos/debug");
}

async function handleBlobExists(
	env: Env,
	vaultId: string,
	req: Request,
): Promise<Response> {
	const bucket = env.YAOS_BUCKET;
	if (!bucket) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	let body: { hashes?: string[] };
	try {
		body = await req.json();
	} catch {
		return json({ error: "invalid json" }, 400);
	}

	if (!Array.isArray(body.hashes)) {
		return json({ error: "missing hashes array" }, 400);
	}

	const hashes = body.hashes
		.slice(0, EXISTS_BATCH_LIMIT)
		.filter((hash): hash is string => typeof hash === "string" && isValidHash(hash));

	const present = await mapWithConcurrency(
		hashes,
		R2_HEAD_CONCURRENCY,
		async (hash) => {
			const object = await bucket.head(blobKey(vaultId, hash));
			return object ? hash : null;
		},
	);

	return json({
		present: present.filter((hash): hash is string => hash !== null),
	});
}

async function handleBlobUpload(
	env: Env,
	vaultId: string,
	hash: string,
	req: Request,
): Promise<Response> {
	if (!env.YAOS_BUCKET) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	const body = await req.arrayBuffer();
	if (!body.byteLength) {
		return json({ error: "missing request body" }, 400);
	}
	if (body.byteLength > MAX_BLOB_UPLOAD_BYTES) {
		return json({
			error: `contentLength exceeds max upload size (${MAX_BLOB_UPLOAD_BYTES} bytes)`,
		}, 413);
	}

	await env.YAOS_BUCKET.put(
		blobKey(vaultId, hash),
		body,
		{
			httpMetadata: {
				contentType: req.headers.get("Content-Type") ?? "application/octet-stream",
			},
		},
	);

	return new Response(null, { status: 204 });
}

async function handleBlobDownload(
	env: Env,
	vaultId: string,
	hash: string,
): Promise<Response> {
	if (!env.YAOS_BUCKET) {
		return json({ error: "attachments_unavailable" }, 503);
	}

	if (!isValidHash(hash)) {
		return json({ error: "invalid hash: must be 64 hex chars (SHA-256)" }, 400);
	}

	const object = await env.YAOS_BUCKET.get(blobKey(vaultId, hash));
	if (!object) {
		return json({ error: "not found" }, 404);
	}

	const headers = new Headers({
		"Cache-Control": "no-store",
	});
	if (object.httpMetadata?.contentType) {
		headers.set("Content-Type", object.httpMetadata.contentType);
	} else {
		headers.set("Content-Type", "application/octet-stream");
	}

	return new Response(object.body, { headers });
}

async function createSnapshotFromLiveDoc(
	env: Env,
	vaultId: string,
	triggeredBy?: string,
): Promise<SnapshotResult> {
	if (!env.YAOS_BUCKET) {
		return {
			status: "unavailable",
			reason: "R2 bucket not configured",
		};
	}

	const update = await fetchVaultDocument(env, vaultId);
	const doc = new Y.Doc();
	if (update.byteLength > 0) {
		Y.applyUpdate(doc, update);
	}

	const index = await createSnapshot(doc, vaultId, env.YAOS_BUCKET, triggeredBy);
	return {
		status: "created",
		snapshotId: index.snapshotId,
		index,
	};
}

const worker = {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (
			req.method === "OPTIONS"
			&& (url.pathname.startsWith("/vault/") || url.pathname.startsWith("/api/"))
		) {
			return corsPreflight();
		}

		const authState = await getAuthState(env);

		if (req.method === "GET" && url.pathname === "/") {
			const body = authState.claimed
				? renderRunningPage({
					host: url.origin,
					authMode: authState.mode,
					attachments: supportsBuckets(env),
					snapshots: supportsBuckets(env),
				})
				: renderSetupPage({
					host: url.origin,
					deployRepo: canonicalRepoForSetup(env),
				});
			return html(body);
		}

		if (req.method === "GET" && url.pathname === "/mobile-setup") {
			return html(
				renderMobileSetupPage({
					host: url.origin,
					deployRepo: canonicalRepoForSetup(env),
				}),
			);
		}

		if (req.method === "GET" && url.pathname === "/api/capabilities") {
			let config: StoredServerConfig | null = null;
			try {
				config = await getStoredServerConfig(env);
			} catch (err) {
				console.warn(`${LOG_PREFIX} config fetch failed for capabilities:`, err);
			}
			return withCors(json(getCapabilities(authState, env, config)));
		}

		if (req.method === "POST" && url.pathname === "/claim") {
			if (authState.claimed) {
				return json({ error: "already_claimed" }, 403);
			}

			let body: { token?: string; vaultId?: string } = {};
			try {
				body = await req.json();
			} catch {
				return json({ error: "invalid json" }, 400);
			}

			if (typeof body.token !== "string" || body.token.trim().length < 32) {
				return json({ error: "invalid token" }, 400);
			}
			if (body.vaultId !== undefined && (typeof body.vaultId !== "string" || body.vaultId.trim().length < 8)) {
				return json({ error: "invalid vaultId" }, 400);
			}

			const token = body.token.trim();
			const vaultId = typeof body.vaultId === "string" ? body.vaultId.trim() : "";
			const tokenHash = await hashToken(token);
			const claimed = await claimServerConfig(env, tokenHash);
			if (!claimed) {
				return json({ error: "already_claimed" }, 403);
			}

			let claimedConfig: StoredServerConfig | null = null;
			try {
				claimedConfig = await getStoredServerConfig(env);
			} catch (err) {
				console.warn(`${LOG_PREFIX} config fetch failed after claim:`, err);
			}

			return json({
				ok: true,
				host: url.origin,
				obsidianUrl: buildObsidianSetupUrl(url.origin, token, vaultId || undefined),
				capabilities: getCapabilities({ mode: "claim", claimed: true, tokenHash }, env, claimedConfig),
			});
		}

		if (req.method === "POST" && url.pathname === "/api/update-metadata") {
			const token = getHttpAuthToken(req);
			if (!authState.claimed) {
				return withCors(json({ error: "unclaimed" }, 503));
			}
			if (authState.mode === "env" && !authState.envToken) {
				return withCors(json({ error: "server_misconfigured" }, 503));
			}
			if (!(await isAuthorized(authState, token))) {
				return withCors(json({ error: "unauthorized" }, 401));
			}

			let body: {
				updateProvider?: unknown;
				updateRepoUrl?: unknown;
				updateRepoBranch?: unknown;
			} = {};
			try {
				body = await req.json();
			} catch {
				return withCors(json({ error: "invalid json" }, 400));
			}

			let updatedConfig: StoredServerConfig;
			try {
				updatedConfig = await setServerUpdateMetadata(env, body);
			} catch (err) {
				const message = err instanceof Error ? err.message : "metadata write failed";
				const status = message.includes("(403)")
					? 403
					: message.includes("(400)")
						? 400
						: 500;
				return withCors(json({ error: message }, status));
			}

			return withCors(json({
				ok: true,
				capabilities: getCapabilities(authState, env, updatedConfig),
			}));
		}

		const syncRoute = parseSyncPath(url.pathname);

		if (syncRoute) {
			const token = getSocketAuthToken(req);
			const clientSchema = parseClientSchemaVersion(url);
			if (!authState.claimed) {
				await recordVaultTrace(env, syncRoute.vaultId, "ws-rejected", {
					reason: "unclaimed",
				});
				const response = rejectSocket(req, "unclaimed");
				return isWebSocketRequest(req) ? response : withCors(response);
			}
			if (authState.mode === "env" && !authState.envToken) {
				await recordVaultTrace(env, syncRoute.vaultId, "ws-rejected", {
					reason: "server_misconfigured",
				});
				const response = rejectSocket(req, "server_misconfigured");
				return isWebSocketRequest(req) ? response : withCors(response);
			}
			if (!(await isAuthorized(authState, token))) {
				await recordVaultTrace(env, syncRoute.vaultId, "ws-rejected", {
					reason: "unauthorized",
				});
				const response = rejectSocket(req, "unauthorized");
				return isWebSocketRequest(req) ? response : withCors(response);
			}
			if (!clientSchema) {
				await recordVaultTrace(env, syncRoute.vaultId, "ws-rejected", {
					reason: "update_required",
					detail: "invalid_client_schema",
					rawSchema: url.searchParams.get("schemaVersion") ?? url.searchParams.get("schema") ?? null,
				});
				const response = rejectSocket(req, "update_required", {
					reason: "invalid_client_schema",
					clientSchemaVersion: null,
					roomSchemaVersion: null,
				});
				return isWebSocketRequest(req) ? response : withCors(response);
			}

			const roomSchemaVersion = await fetchVaultSchemaVersion(env, syncRoute.vaultId);
			if (roomSchemaVersion !== null && clientSchema.version < roomSchemaVersion) {
				await recordVaultTrace(env, syncRoute.vaultId, "ws-rejected", {
					reason: "update_required",
					detail: "client_schema_older_than_room",
					clientSchemaVersion: clientSchema.version,
					clientSchemaSource: clientSchema.source,
					roomSchemaVersion,
				});
				const response = rejectSocket(req, "update_required", {
					reason: "client_schema_older_than_room",
					clientSchemaVersion: clientSchema.version,
					roomSchemaVersion,
				});
				return isWebSocketRequest(req) ? response : withCors(response);
			}

			await recordVaultTrace(env, syncRoute.vaultId, "ws-connected", {
				userAgent: req.headers.get("user-agent") ?? undefined,
				cfRay: req.headers.get("cf-ray") ?? undefined,
				clientSchemaVersion: clientSchema.version,
				clientSchemaSource: clientSchema.source,
				roomSchemaVersion,
			});

			const stub = await getServerByName(env.YAOS_SYNC, syncRoute.vaultId);
			return await stub.fetch(req);
		}

		const vaultRoute = parseVaultPath(url.pathname);
		if (!vaultRoute) {
			return withCors(json({ error: "not found" }, 404));
		}

		const token = getHttpAuthToken(req);
		if (!authState.claimed) {
			await recordVaultTrace(env, vaultRoute.vaultId, "http-rejected", {
				reason: "unclaimed",
				method: req.method,
				path: url.pathname,
			});
			return withCors(json({ error: "unclaimed" }, 503));
		}
		if (authState.mode === "env" && !authState.envToken) {
			await recordVaultTrace(env, vaultRoute.vaultId, "http-rejected", {
				reason: "server_misconfigured",
				method: req.method,
				path: url.pathname,
			});
			return withCors(json({ error: "server_misconfigured" }, 503));
		}
		if (!(await isAuthorized(authState, token))) {
			await recordVaultTrace(env, vaultRoute.vaultId, "http-unauthorized", {
				method: req.method,
				path: url.pathname,
			});
			return withCors(json({ error: "unauthorized" }, 401));
		}

		const [resource, ...rest] = vaultRoute.rest;
		if (!resource) {
			return withCors(json({ error: "not found" }, 404));
		}

		if (resource === "debug" && req.method === "GET" && rest[0] === "recent") {
			return withCors(await fetchVaultDebug(env, vaultRoute.vaultId));
		}

		if (resource === "blobs") {
			if (req.method === "POST" && rest[0] === "exists") {
				return withCors(await handleBlobExists(env, vaultRoute.vaultId, req));
			}

				const hash = rest[0];
				if (!hash) {
					return withCors(json({ error: "not found" }, 404));
				}

			if (req.method === "PUT" && rest.length === 1) {
				return withCors(await handleBlobUpload(env, vaultRoute.vaultId, hash, req));
			}

			if (req.method === "GET" && rest.length === 1) {
				return withCors(await handleBlobDownload(env, vaultRoute.vaultId, hash));
			}
		}

		if (resource === "snapshots") {
			if (req.method === "POST" && rest.length === 0) {
				let body: { device?: string } = {};
				try {
					body = await req.json();
				} catch {
					body = {};
				}

				const result = await createSnapshotFromLiveDoc(
					env,
					vaultRoute.vaultId,
					body.device,
				);
				if (result.status === "unavailable") {
					return withCors(json(result));
				}
				await recordVaultTrace(env, vaultRoute.vaultId, "snapshot-created-manual", {
					snapshotId: result.snapshotId,
					triggeredBy: body.device,
				});
				return withCors(json(result));
			}

			if (req.method === "POST" && rest[0] === "maybe" && rest.length === 1) {
				let body: { device?: string } = {};
				try {
					body = await req.json();
				} catch {
					body = {};
				}

				const stub = await getServerByName(env.YAOS_SYNC, vaultRoute.vaultId);
				const res = await stub.fetch("https://internal/__yaos/snapshot-maybe", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				const result = await res.json() as SnapshotResult;
				await recordVaultTrace(env, vaultRoute.vaultId, "snapshot-created", {
					status: result.status,
					snapshotId: result.snapshotId,
					triggeredBy: body.device,
				});
				return withCors(json(result));
			}

			if (req.method === "GET" && rest.length === 0) {
				if (!env.YAOS_BUCKET) {
					return withCors(json({ error: "snapshots_unavailable" }, 503));
				}

				const snapshots = await listSnapshots(vaultRoute.vaultId, env.YAOS_BUCKET);
				return withCors(json({ snapshots }));
			}

			if (req.method === "GET" && rest.length === 1) {
				if (!env.YAOS_BUCKET) {
					return withCors(json({ error: "snapshots_unavailable" }, 503));
				}

				const snapshotId = rest[0];
				if (!snapshotId) {
					return withCors(json({ error: "missing_snapshot_id" }, 400));
				}
				const result = await getSnapshotPayload(
					vaultRoute.vaultId,
					snapshotId,
					env.YAOS_BUCKET,
				);
				if (!result) {
					return withCors(json({ error: "not found" }, 404));
				}

				return withCors(new Response(result.payload, {
					headers: {
						"Content-Type": "application/gzip",
						"Cache-Control": "no-store",
						"X-YAOS-Snapshot-Day": result.index.day,
					},
				}));
			}
		}

		return withCors(json({ error: "not found" }, 404));
	},
};

export default worker;
export { ServerConfig, VaultSyncServer };
