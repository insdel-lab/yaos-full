import {
	appendTraceEntry,
	listRecentTraceEntries,
	MAX_TRACE_ENTRY_BYTES,
	prepareTraceEntryForStorage,
	type TraceEntry,
} from "../server/src/traceStore";

class FakeStorage {
	readonly data = new Map<string, unknown>();

	async list<T = unknown>(options: DurableObjectListOptions = {}): Promise<Map<string, T>> {
		let keys = [...this.data.keys()].sort((a, b) => a.localeCompare(b));
		if (options.prefix) {
			keys = keys.filter((key) => key.startsWith(options.prefix!));
		}
		if (options.start !== undefined) {
			keys = keys.filter((key) => key >= options.start!);
		}
		if (options.startAfter !== undefined) {
			keys = keys.filter((key) => key > options.startAfter!);
		}
		if (options.end !== undefined) {
			keys = keys.filter((key) => key < options.end!);
		}
		if (options.reverse) {
			keys.reverse();
		}
		if (options.limit !== undefined) {
			keys = keys.slice(0, options.limit);
		}
		const out = new Map<string, T>();
		for (const key of keys) {
			out.set(key, this.data.get(key) as T);
		}
		return out;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.data.set(key, value);
	}

	async delete(keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.data.delete(key)) deleted++;
		}
		return deleted;
	}
}

class SizeBoundStorage extends FakeStorage {
	constructor(private readonly maxValueBytes: number) {
		super();
	}

	override async put<T>(key: string, value: T): Promise<void> {
		const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
		if (byteLength > this.maxValueBytes) {
			throw new Error(`SQLITE_TOOBIG: ${byteLength} > ${this.maxValueBytes}`);
		}
		await super.put(key, value);
	}
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
	if (condition) {
		console.log(`  PASS  ${msg}`);
		passed++;
		return;
	}
	console.error(`  FAIL  ${msg}`);
	failed++;
}

function makeEntry(i: number): TraceEntry {
	return {
		ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
		event: `event-${i}`,
		roomId: "room-a",
		seq: i,
	};
}

function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

console.log("\n--- Test 1: trace store keeps only the newest bounded entries ---");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 250; i++) {
		await appendTraceEntry(storage, makeEntry(i), 100);
	}

	const allKeys = [...storage.data.keys()];
	assert(allKeys.length === 100, "trace store retains exactly the newest 100 entries");
	assert(allKeys.every((key) => key.startsWith("trace:")), "trace store writes per-entry prefixed keys");

	const recent = await listRecentTraceEntries(storage, 100);
	assert(recent.length === 100, "debug read returns bounded recent trace entries");
	assert((recent[0] as { seq?: unknown }).seq === 249, "most recent trace entry is returned first");
	assert((recent.at(-1) as { seq?: unknown })?.seq === 150, "oldest retained trace entry is the 100th newest");
}

console.log("\n--- Test 2: trace store cleanup removes old backlog in one pass ---");
{
	const storage = new FakeStorage();
	for (let i = 0; i < 1000; i++) {
		const key = `trace:${String(i).padStart(13, "0")}:manual`;
		await storage.put(key, makeEntry(i));
	}

	await appendTraceEntry(storage, makeEntry(1001), 100);

	const allKeys = [...storage.data.keys()].sort((a, b) => a.localeCompare(b));
	assert(allKeys.length === 100, "cleanup collapses oversized historical backlog down to the bound");
	assert(allKeys[0]?.includes("0000000000901"), "cleanup keeps only the newest bounded key range");
}

console.log("\n--- Test 3: oversized trace entries are truncated to a safe size ---");
{
	const storage = new SizeBoundStorage(MAX_TRACE_ENTRY_BYTES);
	const prepared = prepareTraceEntryForStorage({
		ts: new Date().toISOString(),
		event: "oversized-trace",
		roomId: "room-a",
		hugeString: "x".repeat(MAX_TRACE_ENTRY_BYTES * 4),
		hugeArray: Array.from({ length: 100 }, (_, i) => `item-${i}`),
		nested: {
			deep: {
				payload: "y".repeat(MAX_TRACE_ENTRY_BYTES * 2),
			},
		},
	});

	assert(jsonBytes(prepared) <= MAX_TRACE_ENTRY_BYTES, "prepared trace entry fits within the storage byte budget");
	assert(prepared.traceTruncated === true, "oversized trace entry is marked as truncated");

	await appendTraceEntry(storage, prepared, 10);
	assert(storage.data.size === 1, "sanitized oversized trace entry can be persisted");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
