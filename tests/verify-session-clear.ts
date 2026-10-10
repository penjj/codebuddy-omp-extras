/**
 * Verifies the second half of the cross-session-bleed fix: the extension's
 * `session_start` handler must clear the cached session even though omp emits
 * `{type:"session_start"}` with NO `reason` field.
 *
 * Run: bun /tmp/verify-session-clear.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const OMP = process.env.OMP_HOME ?? join(homedir(), ".omp");
const SDK_ENTRY = process.env.CB_SDK_ENTRY ?? join(OMP, "plugins/node_modules/pi-codebuddy-sdk/src/index.ts");

const sdkMod = await import(SDK_ENTRY);
const sdkExt = sdkMod.default;
const { __test } = sdkMod;

const handlers: Record<string, Function[]> = {};
const seen: string[] = [];

// Minimal stand-in for omp's ExtensionAPI: record `on()` registrations,
// swallow everything else.
const pi: any = new Proxy(
	{},
	{
		get(_t, prop: string) {
			if (prop === "on") {
				return (evt: string, h: Function) => {
					(handlers[evt] ||= []).push(h);
				};
			}
			return (..._a: any[]) => {
				seen.push(prop);
				return undefined;
			};
		},
	},
);

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = "") => {
	if (cond) {
		pass++;
		console.log(`  PASS   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL   ${name}   ${extra}`);
	}
};

console.log("\n=== register the extension against a mock ExtensionAPI ===");
try {
	// NOTE: the export is `async function`, so it must be awaited — otherwise it
	// returns at the first await and no handler ever gets registered.
	await (sdkExt as any)(pi);
	console.log(`  registered handlers: ${Object.keys(handlers).join(", ")}`);
} catch (e) {
	console.log("  (registration threw) " + ((e as Error)?.message ?? String(e)));
}

console.log("\n=== 1. session_start is registered ===");
check("session_start handler registered", (handlers["session_start"]?.length ?? 0) > 0);

console.log("\n=== 2. THE BUG: omp emits {type:'session_start'} with NO reason ===");
// Seed a stale session that belongs to a *previous* conversation.
__test.setSharedSession({ sessionId: "STALE-prev-convo", cursor: 7, cwd: "/tmp/verify-proj", lastUsedAt: Date.now() });
const before = __test.getSharedSession();
check("stale session seeded", before?.sessionId === "STALE-prev-convo", JSON.stringify(before));

const ctx: any = { ui: { setStatus() {}, notify() {} }, cwd: "/tmp/verify-proj" };
for (const h of handlers["session_start"] ?? []) {
	try {
		h({ type: "session_start" }, ctx); // exactly what omp sends — no reason
	} catch (e) {
		console.log("  handler threw: " + (e as Error).message);
	}
}
const after = __test.getSharedSession();
check("sharedSession cleared on session_start", after === null, JSON.stringify(after));

console.log("\n=== 3. session_switch / session_before_switch also clear ===");
for (const evt of ["session_before_switch", "session_switch"]) {
	__test.setSharedSession({ sessionId: `STALE-${evt}`, cursor: 7, cwd: "/tmp/verify-proj", lastUsedAt: Date.now() });
	for (const h of handlers[evt] ?? []) {
		try {
			h({ type: evt, reason: "new" }, ctx);
		} catch (e) {
			console.log(`  ${evt} handler threw: ` + (e as Error).message);
		}
	}
	check(`${evt} clears sharedSession`, __test.getSharedSession() === null, JSON.stringify(__test.getSharedSession()));
}

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"}  —  pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
