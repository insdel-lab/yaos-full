export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];

	const normalizedLimit = Math.max(1, Math.min(limit, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (true) {
			const index = nextIndex;
			nextIndex++;
			if (index >= items.length) return;
				const item = items[index];
				if (item === undefined) return;
				results[index] = await worker(item, index);
			}
		}

	await Promise.all(
		Array.from({ length: normalizedLimit }, () => runWorker()),
	);

	return results;
}
