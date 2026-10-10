/**
 * Verifies the codebuddy-usage status-bar line actually renders.
 * Loads the real extension, registers it against a mock ExtensionAPI that
 * records ctx.ui.setStatus calls, then fires the same events omp fires.
 *
 * Run: bun /tmp/verify-status-bar.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const OMP = process.env.OMP_HOME ?? join(homedir(), ".omp");
const EXT_ENTRY = process.env.CB_USAGE_ENTRY ?? join(OMP, "agent/extensions/codebuddy-usage/index.ts");

const ext = (await import(EXT_ENTRY)).default;

const handlers: Record<string, Function[]> = {};
const commands: Record<string, any> = {};
const statusCalls: Array<{ key: string; text: string }> = [];
const notifyCalls: string[] = [];

const pi: any = new Proxy(
	{},
	{
		get(_t, prop: string) {
			if (prop === "on") return (evt: string, h: Function) => void ((handlers[evt] ||= []).push(h));
			if (prop === "registerCommand") return (name: string, spec: any) => void (commands[name] = spec);
			return () => undefined;
		},
	},
);

const ctx: any = {
	hasUI: true,
	ui: {
		setStatus(key: string, text: string) {
			statusCalls.push({ key, text });
		},
		notify(msg: string) {
			notifyCalls.push(msg);
		},
	},
};

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

console.log("\n=== register extension ===");
(ext as any)(pi);
console.log(`  events: ${Object.keys(handlers).join(", ")}`);
console.log(`  commands: ${Object.keys(commands).join(", ")}`);

check("session_start handler registered", (handlers["session_start"]?.length ?? 0) > 0);
check("turn_end handler registered", (handlers["turn_end"]?.length ?? 0) > 0);
check("cb-usage command still registered", Boolean(commands["cb-usage"]));

console.log("\n=== fire session_start (what omp sends) ===");
const t0 = Date.now();
for (const h of handlers["session_start"] ?? []) h({ type: "session_start" }, ctx);
const elapsed = Date.now() - t0;
console.log(`  refresh took ${elapsed} ms`);
console.log(`  setStatus calls: ${JSON.stringify(statusCalls, null, 2)}`);

check("setStatus called", statusCalls.length === 1);
check("uses key 'cb-usage'", statusCalls[0]?.key === "cb-usage");
const text = statusCalls[0]?.text ?? "";
check("line mentions the current session (会话) or the scan hint", text.includes("会话") || text.includes("未扫描"), text);
check("no crash / no warning notify", notifyCalls.length === 0, JSON.stringify(notifyCalls));

console.log("\n=== throttle: turn_end within 10s must NOT rescan ===");
statusCalls.length = 0;
for (const h of handlers["turn_end"] ?? []) h({ type: "turn_end" }, ctx);
check("throttled (no extra refresh yet)", statusCalls.length === 0, JSON.stringify(statusCalls));

console.log("\n=== after the 10s window, turn_end refreshes again ===");
await new Promise((r) => setTimeout(r, 10_500));
for (const h of handlers["turn_end"] ?? []) h({ type: "turn_end" }, ctx);
check("refreshed after throttle window", statusCalls.length === 1, JSON.stringify(statusCalls));
console.log(`  line: ${statusCalls[0]?.text}`);

console.log("\n=== /cb-usage quota forces an immediate refresh ===");
statusCalls.length = 0;
await commands["cb-usage"].handler("quota 10000", ctx);
console.log(`  setStatus: ${JSON.stringify(statusCalls)}`);
check("quota command refreshed the bar immediately", statusCalls.length >= 1);
check("bar now shows remaining/total", /剩余/.test(statusCalls.at(-1)?.text ?? ""), statusCalls.at(-1)?.text);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"}  —  pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
