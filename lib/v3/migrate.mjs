/**
 * v2 账本迁移（合同 §4.11）：把 `<dataDir>/ledger.jsonl`（实测 141MB / 15 万行）
 * **流式**读进来，转成 §4.9 明细行 + 两级 rollup。
 *
 * 硬约束：
 *  - 流式（`createReadStream` + `readline`），绝不 `readFileSync` 整个文件；
 *  - 幂等：`entry_key` 唯一索引 + `ON CONFLICT DO NOTHING`，重复跑不会重复计账；
 *  - **不删也不改**旧账本，迁完只写 `meta.migrated_at`；
 *  - 大批量分块（默认 2000 行/事务），每块之间 `await` 一次让出事件循环。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { statusClass } from "./metrics.mjs";
import { deriveEntryKey, projectFromCwd, relPathOf } from "./parser.mjs";

const DEFAULTS = {
	// 主线程也会调这个函数（宿主 effect 里），所以批要小：500 行 ≈ 10–20ms，
	// 批间再按 6ms 时间预算让出事件循环 → 心跳探针测到的 maxStallMs 远低于 16ms。
	batchRows: 500,
	progressEveryRows: 5000,
	yieldEveryMs: 6,
};

function toNum(v) {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function toStr(v) {
	if (typeof v !== "string") return null;
	const s = v.trim();
	return s ? s : null;
}

/**
 * v2 的 projectDir 是路径 slug：`--C--Users-11373-Desktop-JK项目-知识库--`
 * （`:` 与 `\`/`/` 都变成 `-`，再包一层 `--`）。还原成路径后走 `projectFromCwd`，
 * 与会话重新导入的项目名落到同一个 refs。
 */
export function projectFromLegacyDir(slug, home) {
	const raw = toStr(slug);
	if (!raw) return null;
	if (!raw.startsWith("--") || !raw.endsWith("--")) return projectFromCwd(raw, home);
	const inner = raw.slice(2, -2);
	const drive = inner.match(/^([A-Za-z])--(.*)$/);
	if (!drive) return projectFromCwd(raw, home);
	const rest = drive[2].split("-").filter(Boolean).join("/");
	return projectFromCwd(`${drive[1]}:/${rest}`, home);
}

/** v2 账本记录 → §4.9 明细行。`sessionsRoot` 用来把绝对 sessionFile 收成与重新导入相同的 rel，否则同一调用会被计两次。 */
export function legacyRecordToRow(rec, opts = {}) {
	if (!rec || typeof rec !== "object") return null;
	const ts = toNum(rec.ts);
	if (ts === null) return null;
	const sessionFile = toStr(rec.sessionFile);
	const entryId = toStr(rec.entryId);
	const sessionsRoot = toStr(opts.sessionsRoot) ?? "";
	const rel = sessionFile ? relPathOf(sessionsRoot, sessionFile) : null;
	let entryKey = rel && entryId ? deriveEntryKey(rel, entryId) : toStr(rec.entryKey) ?? toStr(rec.id);
	if (!entryKey && sessionFile && entryId) entryKey = `e:${sessionFile}:${entryId}`;
	const duration = toNum(rec.durationMs);
	const ttft = toNum(rec.ttftMs);
	const genMs = duration === null ? null : ttft !== null && duration > ttft ? duration - ttft : duration;
	const costUsd = toNum(rec.costUsd);
	const source = toStr(rec.source);
	const origin = source === "both" ? "both" : source === "backfill" ? "backfill" : "live";
	const status =
		rec.status === "ok"
			? "ok"
			: rec.status === "incomplete"
				? "incomplete"
				: statusClass(rec.status ?? rec.stopReason);
	return {
		ts,
		entryKey: entryKey ?? null,
		convId: toStr(rec.conversationId),
		src: sessionFile,
		model: toStr(rec.model),
		provider: toStr(rec.provider),
		project: projectFromLegacyDir(rec.projectDir, opts.home) ?? toStr(rec.projectDir),
		status,
		origin,
		inTok: toNum(rec.inputTokens),
		outTok: toNum(rec.outputTokens),
		cacheRead: toNum(rec.cacheReadTokens),
		cacheWrite: toNum(rec.cacheWriteTokens),
		reasoningTok: toNum(rec.reasoningTokens),
		totalTok: toNum(rec.totalTokens),
		// v2 语义：costUsd > 0 才是网关真值；= 0 表示「没回填」→ 交给价格表估算
		costSdk: costUsd !== null && costUsd > 0 ? costUsd : 0,
		costEst: null,
		costSource: costUsd !== null && costUsd > 0 ? "sdk" : null,
		priceId: null,
		priceVersion: null,
		ttftMs: ttft,
		genMs,
		e2eMs: duration,
		stopReason: toStr(rec.stopReason),
	};
}

/**
 * 迁移 v2 账本。
 * @param {{store:object, rollup?:object, legacyPath:string, onProgress?:Function,
 *          batchRows?:number, log?:Function, applyPrices?:Function}} opts
 * @returns {Promise<{ok:boolean, rows:number, skipped:number, ms:number, total?:number}>}
 */
export async function migrateLegacyV2(opts = {}) {
	const startedAt = Date.now();
	const store = opts.store;
	const legacyPath = toStr(opts.legacyPath);
	const batchRows = Math.max(1, Math.trunc(toNum(opts.batchRows) ?? DEFAULTS.batchRows));
	const yieldEveryMs = Math.max(0, Math.trunc(toNum(opts.yieldEveryMs) ?? DEFAULTS.yieldEveryMs));
	const onComplete = typeof opts.onComplete === "function" ? opts.onComplete : () => {};
	const countUnpriced = opts.countUnpriced === true;
	const progressEvery = Math.max(1, Math.trunc(toNum(opts.progressEveryRows) ?? DEFAULTS.progressEveryRows));
	const log = typeof opts.log === "function" ? opts.log : () => {};
	const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
	const applyPrices = typeof opts.applyPrices === "function" ? opts.applyPrices : null;
	const rowOpts = { sessionsRoot: toStr(opts.sessionsRoot) ?? "", home: opts.home };

	if (!store || typeof store.insertBatch !== "function") {
		return { ok: false, rows: 0, skipped: 0, ms: 0, error: "store 不可用" };
	}
	if (!legacyPath || !existsSync(legacyPath)) {
		log("info", `没有 v2 账本可迁移：${legacyPath || "(空路径)"}`);
		return { ok: true, rows: 0, skipped: 0, ms: Date.now() - startedAt, total: 0 };
	}

	let totalBytes = 0;
	try {
		totalBytes = statSync(legacyPath).size;
	} catch {
		totalBytes = 0;
	}

	const stream = createReadStream(legacyPath, { encoding: "utf8", highWaterMark: 1 << 20 });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	let rows = 0;
	let skipped = 0;
	let bad = 0;
	let unpricedRows = 0;
	let lastYield = Date.now();
	let batch = [];
	let rollupVersion = Number(store.metaGet("rollup_version") ?? 0) || 0;

	const flush = () => {
		if (!batch.length) return;
		const payload = applyPrices
			? batch.map((row) => {
					const priced = applyPrices(row) ?? row;
					if (countUnpriced && priced.costSource === "unpriced") unpricedRows += 1;
					return priced;
				})
			: batch;
		const result = store.insertBatch(payload, { rollupVersion });
		rollupVersion += 1;
		batch = [];
		return result;
	};

	/** 时间预算让出：批与批之间把事件循环还回去（主线程绝不能卡 >16ms）。 */
	const maybeYield = async () => {
		if (yieldEveryMs <= 0) return;
		if (Date.now() - lastYield < yieldEveryMs) return;
		await new Promise((resolve) => setImmediate(resolve));
		lastYield = Date.now();
	};

	try {
		for await (const line of rl) {
			const text = line.trim();
			if (!text) continue;
			let rec;
			try {
				rec = JSON.parse(text);
			} catch {
				bad++;
				continue;
			}
			const row = legacyRecordToRow(rec, rowOpts);
			if (!row) {
				skipped++;
				continue;
			}
			batch.push(row);
			if (batch.length >= batchRows) {
				const result = flush();
				rows += result?.rows ?? 0;
				skipped += result?.skipped ?? 0;
				// 让出事件循环：worker 才能收到 pause/cancel，主线程才不会卡心跳
				await maybeYield();
			}
			const seen = rows + batch.length;
			if (seen > 0 && seen % progressEvery === 0) {
				onProgress({
					phase: "migrating",
					rows: seen,
					bytes: Math.round(Number(stream.bytesRead ?? 0)),
					total: totalBytes,
					pct: totalBytes > 0 ? Math.min(1, (stream.bytesRead ?? 0) / totalBytes) : null,
					bad,
				});
			}
		}
		const tail = flush();
		rows += tail?.rows ?? 0;
		skipped += tail?.skipped ?? 0;
	} finally {
		rl.close();
		stream.destroy();
	}

	const finishedAt = new Date().toISOString();
	try {
		store.metaSet("migrated_at", finishedAt);
		store.metaSet("legacy_bytes", String(totalBytes));
		store.metaSet("rollup_version", String(rollupVersion));
		if (countUnpriced) store.metaSet("migrated_unpriced_rows", String(unpricedRows));
	} catch (err) {
		log("warn", "写入迁移标记失败：", String(err?.message ?? err));
	}
	const ms = Date.now() - startedAt;
	const summary = {
		ok: true,
		rows,
		skipped,
		bad,
		unpricedRows,
		ms,
		total: totalBytes,
		rollupVersion,
		migratedAt: finishedAt,
	};
	onProgress({ phase: "migrated", rows, bytes: totalBytes, total: totalBytes, pct: 1, bad, ms, unpricedRows });
	log("info", `v2 账本迁移完成：写 ${rows} 行 / 跳过 ${skipped} 行 / 坏行 ${bad} / 未定价 ${unpricedRows} / ${ms}ms`);
	// P0-A：迁移完成后必须有人重建内存 rollup —— 交给调用方的 onComplete（importer 会 reload）
	try {
		onComplete(summary);
	} catch (err) {
		log("warn", "onComplete 回调抛错（忽略）：", String(err?.message ?? err));
	}
	return summary;
}

export default migrateLegacyV2;
