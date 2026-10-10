/**
 * codebuddy-usage — real CodeBuddy credit consumption, no API calls needed.
 *
 * Every model call the CodeBuddy CLI makes is recorded as an OpenTelemetry trace
 * under ~/.codebuddy/traces/<pid>/trace_<id>.json. Each trace has a span named
 * "generation" whose `toolInput` (a JSON string) carries the model API response,
 * including the actual credits the request cost:
 *
 *     { "model": "deepseek-v4.1-flash", "credit": 0.92,
 *       "usage": { "inputTokens": 34448, "outputTokens": 200, "totalTokens": 34648 } }
 *
 * That `credit` is the real, server-computed cost for that request — exactly the
 * number you would get from "querying the interface" after a session. Because it
 * is already persisted on disk, this extension just reads it. No network, no
 * auth, and it covers every CodeBuddy/omp session that ever hit a model.
 *
 * To stay fast (the traces dir is ~2 GB across ~1.6k files), results are cached
 * in a ledger (~/.omp/agent/codebuddy-usage-ledger.json) keyed by each trace
 * file's mtime. A reconcile pass only re-parses files that are new or changed
 * and prunes entries for files that were deleted.
 *
 * "Current session" credits are attributed by time: the active session is the
 * newest session jsonl under ~/.codebuddy/projects/<hash>/<id>.jsonl, whose
 * first message timestamp marks the session start. Generations recorded at or
 * after that point count as the current session.
 *
 * CodeBuddy exposes no balance/quota API, so "remaining / total" is derived from
 * a user-set allotment: `/cb-usage quota <n>` stores your total credit package
 * (cr) in the ledger, and remaining = quota - all-time consumed.
 *
 * Commands:
 *   /cb-usage                 summary (total, today, current session, top models, recent days)
 *   /cb-usage now             current session credits + remaining/total (needs quota)
 *   /cb-usage total           total credits + call count
 *   /cb-usage today           consumption for the current day
 *   /cb-usage model [<q>]      credits grouped by model (optional substring filter)
 *   /cb-usage day [YYYY-MM-DD] credits for one day (defaults to today)
 *   /cb-usage recent [n]       last n sessions (trace files) with their totals
 *   /cb-usage quota [<n>]      show or set your total credit allotment (cr)
 *   /cb-usage rate            static per-model credit multiplier (from cloudhosted.json)
 *   /cb-usage scan            force a full reconcile (re-parse changed trace files)
 *   /cb-usage clear           drop the ledger cache
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRACES_DIR = join(homedir(), ".codebuddy", "traces");
const LEDGER = join(homedir(), ".omp", "agent", "codebuddy-usage-ledger.json");
const PROJECTS_DIR = join(homedir(), ".codebuddy", "projects");

type Entry = {
	ts: number; // epoch ms of the generation (used to attribute "current session" usage)
	day: string; // YYYY-MM-DD, derived from ts
	model: string;
	credit: number;
	inTokens: number;
	outTokens: number;
	file?: string; // which trace file produced this entry (kept for incremental reconcile)
	key?: string; // identity of the underlying usage block, for de-duplication
};

type LedgerFile = {
	version: number;
	files: Record<string, number>; // absolute path -> mtimeMs
	entries: Entry[];
	quota?: number; // user-set total credit allotment (cr); enables "remaining" math
};

function loadLedger(): LedgerFile {
	try {
		const parsed = JSON.parse(readFileSync(LEDGER, "utf-8")) as LedgerFile;
		if (parsed && Array.isArray(parsed.entries) && parsed.files) return parsed;
	} catch {
		// fresh ledger
	}
	return { version: 1, files: {}, entries: [] };
}

function saveLedger(ledger: LedgerFile) {
	try {
		writeFileSync(LEDGER, JSON.stringify(ledger));
	} catch {
		// Non-fatal: next run just re-scans.
	}
}

/** Last capture group of `re` within `s`, or undefined. */
function lastCapture(s: string, re: RegExp): string | undefined {
	let last: string | undefined;
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(s)) !== null) last = m[1];
	return last;
}

const RE_CREDIT = /"credit"\s*:\s*([0-9.]+)/g;
const RE_IN = /"inputTokens"\s*:\s*(\d+)/g;
const RE_OUT = /"(?:outputTokens|completion_tokens)"\s*:\s*(\d+)/g;
const RE_CACHED = /"cached_tokens"\s*:\s*(\d+)/g;
const RE_MODEL = /"model"\s*:\s*"([^"]+)"/g;

/**
 * Every usage block a "generation" span carries.
 *
 * `toolInput` is the FULL request payload, and each prior assistant message in
 * it carries its own `usage` (with `credit`). So one span embeds the credits of
 * every earlier request in the conversation — taking the first match (or
 * summing every span) counts those old credits over and over. We extract all of
 * them, tag each with the identity of its usage block, and de-duplicate
 * globally in reconcile().
 */
function parseSpanUsageEntries(span: any): Omit<Entry, "file">[] {
	if (!span || span.name !== "generation") return [];
	const raw = typeof span.toolInput === "string" ? span.toolInput : "";
	if (!raw) return [];
	const ts = parseTimestampMs(span.startedAt ?? span.endedAt) ?? 0;
	const day = ts ? new Date(ts).toISOString().slice(0, 10) : "unknown";
	const out: Omit<Entry, "file">[] = [];
	let m: RegExpExecArray | null;
	RE_CREDIT.lastIndex = 0;
	while ((m = RE_CREDIT.exec(raw)) !== null) {
		const credit = Number.parseFloat(m[1]);
		if (!Number.isFinite(credit)) continue;
		// The usage block this credit belongs to sits just before it.
		const ahead = raw.slice(Math.max(0, m.index - 2000), m.index);
		const it = lastCapture(ahead, RE_IN);
		const ot = lastCapture(ahead, RE_OUT);
		const ct = lastCapture(ahead, RE_CACHED);
		const model = lastCapture(ahead, RE_MODEL);
		out.push({
			ts,
			day,
			model: model ?? "unknown",
			credit,
			inTokens: it ? Number.parseInt(it, 10) : 0,
			outTokens: ot ? Number.parseInt(ot, 10) : 0,
			key: `${it ?? "-"}|${ot ?? "-"}|${ct ?? "-"}|${credit}`,
		});
	}
	return out;
}

/** Parse a span timestamp (epoch-ms number, or ISO string) into epoch ms. */
function parseTimestampMs(v: unknown): number | undefined {
	if (typeof v === "number") {
		// ms if it looks like an epoch-ms value, else seconds.
		return v > 1e12 ? v : v * 1000;
	}
	if (typeof v === "string") {
		const s = v.replace(/Z$/, "").slice(0, 19).replace("T", " ");
		const d = new Date(s.includes(" ") || s.includes("-") ? s : v);
		return Number.isNaN(d.getTime()) ? undefined : d.getTime();
	}
	return undefined;
}

/** Re-parse one trace file and return its generation entries. */
function scanTraceFile(path: string): Omit<Entry, "file">[] {
	let parsed: any;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return [];
	}
	const spans = Array.isArray(parsed?.spans) ? parsed.spans : [];
	const out: Omit<Entry, "file">[] = [];
	for (const span of spans) {
		out.push(...parseSpanUsageEntries(span));
	}
	return out;
}

function listTraceFiles(): string[] {
	const out: string[] = [];
	let pids: string[];
	try {
		pids = readdirSync(TRACES_DIR);
	} catch {
		return out;
	}
	for (const pid of pids) {
		const dir = join(TRACES_DIR, pid);
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const n of names) {
			if (n.startsWith("trace_") && n.endsWith(".json")) out.push(join(dir, n));
		}
	}
	return out;
}

function statMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Incremental reconcile: only re-parse new/changed files, prune deleted ones. */
function reconcile(force = false): { ledger: LedgerFile; scanned: number; newFiles: number } {
	const ledger = loadLedger();
	const onDisk = listTraceFiles();
	const seen = new Set<string>();
	let scanned = 0;
	let newFiles = 0;

	// Prune entries whose file is already gone from disk.
	ledger.entries = ledger.entries.filter((e) => !e.file || onDisk.includes(e.file));

	const keptFiles = new Set<string>();
	for (const path of onDisk) {
		seen.add(path);
		const mtime = statMtime(path);
		const cached = ledger.files[path];
		if (cached === mtime && !force) {
			keptFiles.add(path); // unchanged -> keep existing entries
			continue;
		}
		const entries = scanTraceFile(path).map((e) => ({ ...e, file: path }));
		// remove this file's stale entries, then add the fresh ones
		ledger.entries = ledger.entries.filter((e) => e.file !== path);
		ledger.entries.push(...entries);
		ledger.files[path] = mtime;
		scanned++;
		if (cached === undefined) newFiles++;
	}

	// Keep only entries from files that are unchanged-present or freshly scanned.
	ledger.entries = ledger.entries.filter((e) => !e.file || keptFiles.has(e.file) || seen.has(e.file));

	// Prune file signatures no longer on disk.
	for (const f of Object.keys(ledger.files)) if (!seen.has(f)) delete ledger.files[f];

	// De-duplicate: the same usage block is embedded in the prompt of every
	// later request, so it shows up in many spans and many files. Without this
	// the totals are inflated several-fold (the old "first match per span"
	// approach reported ~2700 cr where the real figure is under 100).
	const dedup = new Map<string, Entry>();
	for (const e of ledger.entries) {
		const k = e.key ?? `${e.inTokens}|${e.outTokens}|${e.credit}|${e.ts}`;
		const prev = dedup.get(k);
		if (!prev || e.ts < prev.ts) dedup.set(k, e);
	}
	ledger.entries = [...dedup.values()];

	saveLedger(ledger);
	return { ledger, scanned, newFiles };
}

// ---- current session detection ----

/**
 * The active CodeBuddy session is the newest session jsonl under
 * ~/.codebuddy/projects/<hash>/<id>.jsonl; its first message timestamp is the
 * session start. Generations recorded at/after that point belong to "this
 * session".
 */
function currentSessionStartMs(): number | undefined {
	let files: string[] = [];
	try {
		for (const hash of readdirSync(PROJECTS_DIR)) {
			const d = join(PROJECTS_DIR, hash);
			let names: string[];
			try {
				names = readdirSync(d);
			} catch {
				continue;
			}
			for (const n of names) if (n.endsWith(".jsonl")) files.push(join(d, n));
		}
	} catch {
		return undefined;
	}
	if (!files.length) return undefined;
	files.sort((a, b) => statMtime(b) - statMtime(a)); // newest first
	try {
		const firstLine = readFileSync(files[0], "utf-8").split("\n", 1)[0];
		const obj = JSON.parse(firstLine);
		const t = obj?.timestamp;
		if (typeof t === "number") return t;
		if (typeof t === "string" && /^\d+$/.test(t)) return Number(t);
	} catch {
		// ignore
	}
	return undefined;
}

/** Credits consumed in the current session (see currentSessionStartMs). */
function currentSessionCredits(entries: Entry[]): number {
	const start = currentSessionStartMs();
	if (!start) return 0;
	return entries.filter((e) => e.ts >= start).reduce((s, e) => s + e.credit, 0);
}

// ---- static rate table (mirrors codebuddy-refresh) ----

function readBundledModels(): any[] | undefined {
	const roots: string[] = [];
	for (const prefix of (process.env.NODE_PATH ?? "").split(":").map((p) => p.trim()).filter(Boolean)) {
		roots.push(join(prefix, "@tencent-ai", "codebuddy-code"));
	}
	for (const dir of (process.env.PATH ?? "").split(":").map((p) => p.trim()).filter(Boolean)) {
		roots.push(join(dir, "..", "lib", "node_modules", "@tencent-ai", "codebuddy-code"));
		roots.push(join(dir, "..", "node_modules", "@tencent-ai", "codebuddy-code"));
	}
	roots.push(join(homedir(), ".npm-global", "lib", "node_modules", "@tencent-ai", "codebuddy-code"));
	for (const root of roots) {
		for (const file of ["product.cloudhosted.json", "product.json"]) {
			try {
				const parsed = JSON.parse(readFileSync(join(root, file), "utf-8"));
				if (Array.isArray(parsed?.models) && parsed.models.length) return parsed.models;
			} catch {
				// next
			}
		}
	}
	return undefined;
}

function parseRate(raw: string | number | null | undefined): number | undefined {
	if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
	if (typeof raw !== "string") return undefined;
	const m = raw.match(/(\d+(?:\.\d+)?)/);
	if (!m) return undefined;
	const v = Number.parseFloat(m[1]);
	return Number.isFinite(v) && v >= 0 ? v : undefined;
}

// ---- helpers ----

function report(pi: ExtensionAPI, ctx: any, text: string, level: "info" | "warning" = "info") {
	if (ctx?.hasUI) ctx.ui.notify(text, level);
	else pi.sendMessage({ customType: "cb-usage", content: text, display: true });
}

function fmt(n: number): string {
	return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function aggregate(entries: Entry[]) {
	const byModel = new Map<string, number>();
	const byDay = new Map<string, number>();
	let total = 0;
	let inT = 0;
	let outT = 0;
	for (const e of entries) {
		total += e.credit;
		inT += e.inTokens;
		outT += e.outTokens;
		byModel.set(e.model, (byModel.get(e.model) ?? 0) + e.credit);
		byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.credit);
	}
	return { byModel, byDay, total, inT, outT, count: entries.length };
}

// ---- live status bar (shows up next to the built-in stats, no command needed) ----

const STATUS_KEY = "cb-usage";
let lastStatusRefresh = 0;

/**
 * One line for the footer status bar: current session credits, and remaining /
 * total when a quota is configured. Returns undefined when we have nothing to
 * show (never scanned yet, or the read failed) so we don't clobber the bar.
 */
function statusText(): string | undefined {
	try {
		const { ledger } = reconcile(false);
		const entries = ledger.entries ?? [];
		if (!entries.length) return "cb-usage: 未扫描 · /cb-usage scan";
		const a = aggregate(entries);
		const session = currentSessionCredits(entries);
		const stamp = dataStamp(entries);
		if (ledger.quota === undefined) {
			return `会话 ${fmt(session)} cr · 合计 ${fmt(a.total)} cr${stamp} · /cb-usage quota <总积分>`;
		}
		const left = Math.max(0, ledger.quota - a.total);
		return `会话 ${fmt(session)} cr · 剩余 ${fmt(left)}/${fmt(ledger.quota)} cr${stamp}`;
	} catch {
		return undefined;
	}
}

/**
 * Traces are only flushed when the CodeBuddy CLI subprocess exits, so during a
 * long omp session the newest entry can be hours old — which makes the session
 * figure read 0 even though credits are being spent. Surface the age instead of
 * silently showing a stale number.
 */
function dataStamp(entries: Entry[]): string {
	let newest: number | undefined;
	for (const e of entries) {
		if (typeof e.ts === "number" && (newest === undefined || e.ts > newest)) newest = e.ts;
	}
	if (newest === undefined || Date.now() - newest <= 30 * 60 * 1000) return "";
	const d = new Date(newest);
	const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return ` ·数据 ${d.getMonth() + 1}-${d.getDate()} ${hhmm}`;
}

/**
 * Push the line to the status bar. Throttled: reconcile() walks the traces
 * directory, so we don't want to run it on every single turn event.
 */
function refreshStatus(ctx: any, force = false): void {
	if (!ctx?.ui?.setStatus) return;
	const now = Date.now();
	if (!force && now - lastStatusRefresh < 10_000) return;
	lastStatusRefresh = now;
	try {
		const text = statusText();
		if (text) ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// never break a turn over a status line
	}
}

export default function codebuddyUsage(pi: ExtensionAPI) {
	// Keep the footer line alive across the conversation.
	pi.on("session_start", (_event, ctx) => refreshStatus(ctx, true));
	pi.on("turn_end", (_event, ctx) => refreshStatus(ctx));

	pi.registerCommand("cb-usage", {
		description:
			"CodeBuddy credit consumption (reads ~/.codebuddy/traces): summary | now | total | today | model [q] | day [date] | recent [n] | quota [n] | rate | scan | clear",
		getArgumentCompletions(prefix: string) {
			const actions = ["summary", "now", "total", "today", "model", "day", "recent", "quota", "rate", "scan", "clear"];
			const hits = actions.filter((a) => a.startsWith(prefix)).map((value) => ({ value, label: value }));
			return hits.length ? hits : null;
		},
		async handler(args: string, ctx: any) {
			const action = (args || "summary").trim().split(/\s+/)[0] || "summary";
			const rest = args.trim().split(/\s+/).slice(1).join(" ");
			try {
				if (action === "clear") {
					try {
						writeFileSync(LEDGER, JSON.stringify({ version: 1, files: {}, entries: [] }));
					} catch {
						// ignore
					}
					report(pi, ctx, "Cleared the credit ledger. Next /cb-usage run re-scans all traces.");
					return;
				}

				if (action === "rate") {
					const models = readBundledModels();
					if (!models) {
						report(pi, ctx, "Could not locate codebuddy-code product tables.", "warning");
						return;
					}
					const lines = ["CodeBuddy credit multiplier (relative, from cloudhosted.json):"];
					const shown = models
						.filter((m) => typeof m.credits === "string" || typeof m.credits === "number")
						.slice(0, 24)
						.sort((a, b) => (parseRate(b.credits) ?? 0) - (parseRate(a.credits) ?? 0));
					for (const m of shown) {
						const r = parseRate(m.credits);
						lines.push(`  ${String(m.id).padEnd(26)} x${r?.toFixed(2) ?? "?"} cr`);
					}
					report(pi, ctx, lines.join("\n"));
					return;
				}

				// All other actions need the ledger.
				const { ledger, scanned, newFiles } = reconcile(action === "scan");
				const entries = ledger.entries;

				if (action === "scan") {
					report(
						pi,
						ctx,
						`Reconciled traces: ${scanned} file(s) parsed (${newFiles} new), ${entries.length} generation calls indexed.\nRun /cb-usage for the summary.`,
					);
					return;
				}

				if (action === "quota") {
					const q = rest.trim();
					if (q) {
						const n = Number.parseFloat(q);
						if (!Number.isFinite(n) || n < 0) {
							report(pi, ctx, "quota 必须是一个非负数（单位 cr）。", "warning");
							return;
						}
						ledger.quota = n;
						saveLedger(ledger);
						report(pi, ctx, `已设置积分配额: ${fmt(n)} cr`);
						return;
					}
					report(
						pi,
						ctx,
						ledger.quota === undefined
							? "未设置配额。用 /cb-usage quota <总积分> 设置，例如 /cb-usage quota 1000"
							: `当前配额: ${fmt(ledger.quota)} cr（剩余 ${fmt(Math.max(0, ledger.quota - aggregate(entries).total))} cr）`,
					);
					return;
				}

				if (action === "now" || action === "session") {
					const sessionCredit = currentSessionCredits(entries);
					const total = aggregate(entries).total;
					if (ledger.quota === undefined) {
						report(
							pi,
							ctx,
							`当前会话积分: ${fmt(sessionCredit)} cr\n总消耗: ${fmt(total)} cr\n（未设置配额，用 /cb-usage quota <总积分> 设置后显示剩余）`,
						);
					} else {
						const remaining = Math.max(0, ledger.quota - total);
						report(
							pi,
							ctx,
							`当前会话: ${fmt(sessionCredit)} cr | 剩余: ${fmt(remaining)} / 总: ${fmt(ledger.quota)} cr（已消耗 ${fmt(total)}）`,
						);
					}
					return;
				}

				if (action === "total") {
					const a = aggregate(entries);
					report(
						pi,
						ctx,
						`Total CodeBuddy credits consumed: ${fmt(a.total)} cr\n` +
							`  calls: ${a.count}\n  input tokens: ${fmt(a.inT)}\n  output tokens: ${fmt(a.outT)}`,
					);
					return;
				}

				if (action === "today") {
					const day = todayStr();
					const a = aggregate(entries.filter((e) => e.day === day));
					report(
						pi,
						ctx,
						a.count
							? `Today (${day}): ${fmt(a.total)} cr across ${a.count} call(s)`
							: `Today (${day}): no recorded model calls yet.`,
					);
					return;
				}

				if (action === "day") {
					const day = /^\d{4}-\d{2}-\d{2}$/.test(rest) ? rest : todayStr();
					const a = aggregate(entries.filter((e) => e.day === day));
					if (!a.count) {
						report(pi, ctx, `No recorded usage on ${day}.`);
						return;
					}
					const lines = [`Credits on ${day}: ${fmt(a.total)} cr (${a.count} call(s))`, "  by model:"];
					for (const [m, c] of [...a.byModel.entries()].sort((x, y) => y[1] - x[1])) {
						lines.push(`    ${m.padEnd(26)} ${fmt(c)} cr`);
					}
					report(pi, ctx, lines.join("\n"));
					return;
				}

				if (action === "model") {
					const q = rest.trim().toLowerCase();
					const a = aggregate(entries);
					const rows = [...a.byModel.entries()]
						.filter(([m]) => !q || m.toLowerCase().includes(q))
						.sort((x, y) => y[1] - x[1]);
					if (!rows.length) {
						report(pi, ctx, q ? `No model matches "${q}".` : "No model usage recorded.");
						return;
					}
					const lines = [`Credits by model${q ? ` (filter "${q}")` : ""} (total ${fmt(a.total)} cr):`];
					for (const [m, c] of rows) {
						lines.push(`  ${m.padEnd(28)} ${fmt(c).padStart(10)} cr`);
					}
					report(pi, ctx, lines.join("\n"));
					return;
				}

				if (action === "recent") {
					const n = Math.max(1, Math.min(50, Number.parseInt(rest, 10) || 10));
					const byFile = new Map<string, { credit: number; models: Map<string, number>; day: string }>();
					for (const e of entries) {
						const f = e.file ?? "?";
						let g = byFile.get(f);
						if (!g) {
							g = { credit: 0, models: new Map(), day: e.day };
							byFile.set(f, g);
						}
						g.credit += e.credit;
						g.models.set(e.model, (g.models.get(e.model) ?? 0) + e.credit);
					}
					const sessions = [...byFile.entries()].sort((x, y) => y[1].day.localeCompare(x[1].day)).slice(0, n);
					if (!sessions.length) {
						report(pi, ctx, "No sessions recorded yet.");
						return;
					}
					const lines = [`Last ${sessions.length} session(s):`];
					for (const [f, g] of sessions) {
						const top = [...g.models.entries()].sort((x, y) => y[1] - x[1])[0];
						const label = top ? `${top[0]} ${fmt(top[1])}cr` : "";
						lines.push(`  ${g.day}  ${fmt(g.credit).padStart(9)} cr  ${f.split("/").pop()}  ${label}`);
					}
					report(pi, ctx, lines.join("\n"));
					return;
				}

				// summary (default)
				const a = aggregate(entries);
				const lines: string[] = [];
				if (!a.count) {
					lines.push(
						"CodeBuddy credit usage: no traces scanned yet.",
						"Run `/cb-usage scan` to index ~/.codebuddy/traces (first run parses ~2 GB, takes a few seconds).",
					);
				} else {
					lines.push(
						`CodeBuddy credits consumed: ${fmt(a.total)} cr  (${a.count} calls, ${fmt(a.inT)} in / ${fmt(a.outT)} out tokens)`,
						`Today (${todayStr()}): ${fmt(aggregate(entries.filter((e) => e.day === todayStr())).total)} cr`,
						`当前会话: ${fmt(currentSessionCredits(entries))} cr`,
						"",
						"Top models:",
					);
					for (const [m, c] of [...a.byModel.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
						const pct = a.total ? Math.round((c / a.total) * 100) : 0;
						lines.push(`  ${m.padEnd(28)} ${fmt(c).padStart(10)} cr  (${pct}%)`);
					}
					const days = [...a.byDay.entries()].sort((x, y) => y[0].localeCompare(x[0])).slice(0, 8);
					lines.push("", "Recent days:");
					for (const [d, c] of days) lines.push(`  ${d}  ${fmt(c).padStart(9)} cr`);
					if (ledger.quota === undefined) {
						lines.push("", "（未设置配额，用 /cb-usage quota <总积分> 设置后可看剩余）");
					} else {
						lines.push("", `配额: ${fmt(ledger.quota)} cr | 剩余: ${fmt(Math.max(0, ledger.quota - a.total))} cr`);
					}
					lines.push(
						"",
						"⚠️ 这是下限估算：credit 只存在于请求的 prompt 里，而该字段被 CLI 截断在约 100KB，",
						"   长对话后期的请求积分读不到。用量级/趋势参考，别当账单。",
					);
				}
				report(pi, ctx, lines.join("\n"));
			} catch (e) {
				report(pi, ctx, `cb-usage failed: ${(e as Error)?.message ?? String(e)}`, "warning");
			} finally {
				// e.g. `/cb-usage quota 10000` should update the status bar right away
				refreshStatus(ctx, true);
			}
		},
	});
}
