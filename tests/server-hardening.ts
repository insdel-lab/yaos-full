import { runSerialized, runSingleFlight } from "../server/src/asyncConcurrency";

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

console.log("\n--- Test 1: runSingleFlight shares one in-flight cold-start load ---");
{
	let loadCalls = 0;
	let releaseLoad: (() => void) | null = null;
	const loadGate = new Promise<void>((resolve) => {
		releaseLoad = resolve;
	});

	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			await loadGate;
		});

	const pending = Promise.all([loadRoom(), loadRoom(), loadRoom()]);
	releaseLoad?.();
	await pending;

	assert(loadCalls === 1, "concurrent cold-start callers share one load task");
	assert(gate.inFlight === null, "single-flight gate clears after a successful load");
}

console.log("\n--- Test 2: runSingleFlight clears after a failed load so the next call can retry ---");
{
	let loadCalls = 0;
	let shouldFail = true;
	const gate = { inFlight: null as Promise<void> | null };
	const loadRoom = () =>
		runSingleFlight(gate, async () => {
			loadCalls++;
			if (shouldFail) {
				throw new Error("boom");
			}
		});

	let sawFailure = false;
	try {
		await loadRoom();
	} catch {
		sawFailure = true;
	}

	assert(sawFailure, "failed single-flight load surfaces the original error");
	assert(gate.inFlight === null, "single-flight gate clears after a failed load");

	shouldFail = false;
	await loadRoom();
	assert(loadCalls === 2, "single-flight load can retry after a failure");
	assert(gate.inFlight === null, "single-flight gate clears after the retry succeeds");
}

console.log("\n--- Test 3: runSerialized keeps snapshot maybe logic single-filed under concurrency ---");
{
	const serialized = { chain: Promise.resolve() };
	let activeRuns = 0;
	let maxActiveRuns = 0;
	let created = false;

	const maybeCreateSnapshot = (triggeredBy: string) =>
		runSerialized(serialized, async () => {
			activeRuns++;
			maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
			try {
				await new Promise((resolve) => setTimeout(resolve, 5));
				if (created) {
					return {
						status: "noop" as const,
						triggeredBy,
					};
				}
				created = true;
				return {
					status: "created" as const,
					triggeredBy,
				};
			} finally {
				activeRuns--;
			}
		});

	const results = await Promise.all([
		maybeCreateSnapshot("device-a"),
		maybeCreateSnapshot("device-b"),
		maybeCreateSnapshot("device-c"),
		maybeCreateSnapshot("device-d"),
	]);
	const createdResults = results.filter((result) => result.status === "created");
	const noopResults = results.filter((result) => result.status === "noop");

	assert(maxActiveRuns === 1, "serialized queue never runs snapshot maybe work concurrently");
	assert(createdResults.length === 1, "serialized snapshot maybe logic produces exactly one created result");
	assert(noopResults.length === results.length - 1, "remaining serialized snapshot maybe calls become noops");
}

console.log("\n──────────────────────────────────────────────────");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("──────────────────────────────────────────────────");

if (failed > 0) {
	process.exit(1);
}
