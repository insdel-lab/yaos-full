import * as Y from "yjs";
import { gzipSync } from "fflate";
import { mapWithConcurrency } from "./concurrency";

export interface SnapshotIndex {
	snapshotId: string;
	vaultId: string;
	createdAt: string;
	day: string;
	schemaVersion: number | undefined;
	markdownFileCount: number;
	blobFileCount: number;
	crdtSizeBytes: number;
	crdtRawSizeBytes: number;
	referencedBlobHashes: string[];
	triggeredBy?: string;
}

export interface SnapshotResult {
	status: "created" | "noop" | "unavailable";
	snapshotId?: string;
	reason?: string;
	index?: SnapshotIndex;
}

const SNAPSHOT_FETCH_CONCURRENCY = 4;

export function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function blobKey(vaultId: string, hash: string): string {
	return `v1/${vaultId}/blobs/${hash}`;
}

function generateSnapshotId(): string {
	const ts = Date.now().toString(36);
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	const rand = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${ts}-${rand}`;
}

function snapshotPrefix(vaultId: string, day: string, snapshotId: string): string {
	return `v1/${vaultId}/snapshots/${day}/${snapshotId}`;
}

function normalizeBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
	if (data instanceof Uint8Array) {
		return data;
	}
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	return new Uint8Array(data);
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	while (true) {
		const page = await bucket.list({
			prefix,
			limit: 1000,
			cursor,
		});

		for (const object of page.objects) {
			keys.push(object.key);
		}

		if (!page.truncated) break;
		cursor = page.cursor;
	}

	return keys;
}

export async function hasSnapshotForDay(
	vaultId: string,
	day: string,
	bucket: R2Bucket,
): Promise<boolean> {
	const page = await bucket.list({
		prefix: `v1/${vaultId}/snapshots/${day}/`,
		limit: 1,
	});
	return page.objects.length > 0;
}

export async function createSnapshot(
	ydoc: Y.Doc,
	vaultId: string,
	bucket: R2Bucket,
	triggeredBy?: string,
): Promise<SnapshotIndex> {
	const day = today();
	const snapshotId = generateSnapshotId();
	const prefix = snapshotPrefix(vaultId, day, snapshotId);

	const rawUpdate = Y.encodeStateAsUpdate(ydoc);
	const compressed = gzipSync(rawUpdate);

	const pathToId = ydoc.getMap<string>("pathToId");
	const pathToBlob = ydoc.getMap<unknown>("pathToBlob");
	const sys = ydoc.getMap<unknown>("sys");

	const referencedBlobHashes: string[] = [];
	pathToBlob.forEach((ref: unknown) => {
		if (!ref || typeof ref !== "object" || !("hash" in ref)) return;
		const hash = (ref as { hash?: unknown }).hash;
		if (typeof hash === "string") {
			referencedBlobHashes.push(hash);
		}
	});

	const index: SnapshotIndex = {
		snapshotId,
		vaultId,
		createdAt: new Date().toISOString(),
		day,
		schemaVersion: sys.get("schemaVersion") as number | undefined,
		markdownFileCount: pathToId.size,
		blobFileCount: pathToBlob.size,
		crdtSizeBytes: compressed.byteLength,
		crdtRawSizeBytes: rawUpdate.byteLength,
		referencedBlobHashes,
		triggeredBy,
	};

	await Promise.all([
		bucket.put(`${prefix}/crdt.bin.gz`, compressed, {
			httpMetadata: {
				contentType: "application/gzip",
			},
		}),
		bucket.put(`${prefix}/index.json`, JSON.stringify(index), {
			httpMetadata: {
				contentType: "application/json",
			},
		}),
	]);

	return index;
}

export async function listSnapshots(
	vaultId: string,
	bucket: R2Bucket,
): Promise<SnapshotIndex[]> {
	const keys = await listAllKeys(bucket, `v1/${vaultId}/snapshots/`);
	const indexKeys = keys.filter((key) => key.endsWith("/index.json"));

	const indexes = await mapWithConcurrency(
		indexKeys,
		SNAPSHOT_FETCH_CONCURRENCY,
		async (key) => {
			try {
				const object = await bucket.get(key);
				if (!object) return null;
				const text = await object.text();
				return JSON.parse(text) as SnapshotIndex;
			} catch {
				return null;
			}
		},
	);

	return indexes
		.filter((index): index is SnapshotIndex => index !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshotPayload(
	vaultId: string,
	snapshotId: string,
	bucket: R2Bucket,
): Promise<{ index: SnapshotIndex; payload: Uint8Array } | null> {
	const snapshots = await listSnapshots(vaultId, bucket);
	const index = snapshots.find((entry) => entry.snapshotId === snapshotId);
	if (!index) return null;

	const object = await bucket.get(
		`${snapshotPrefix(vaultId, index.day, snapshotId)}/crdt.bin.gz`,
	);
	if (!object) return null;

	const body = await object.arrayBuffer();
	return {
		index,
		payload: normalizeBytes(body),
	};
}
