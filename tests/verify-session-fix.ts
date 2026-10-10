/**
 * Executable verification of the cross-session-bleed fix.
 *
 * Loads the REAL patched pi-codebuddy-sdk module and drives its exported
 * test hooks, so this exercises the shipped code rather than a re-implementation.
 *
 * Run: bun /tmp/verify-session-fix.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const OMP = process.env.OMP_HOME ?? join(homedir(), ".omp");
const SDK_ENTRY = process.env.CB_SDK_ENTRY ?? join(OMP, "plugins/node_modules/pi-codebuddy-sdk/src/index.ts");

const { __test } = await import(SDK_ENTRY);

const CWD = "/tmp/verify-proj";
const OTHER_CWD = "/tmp/verify-other";
let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, extra = "") {
	if (cond) {
		pass++;
		console.log(`  PASS   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL   ${name}   ${extra}`);
	}
}

const bareUser = () => [{ role: "user", content: [{ type: "text", text: "hi" }] }] as any;

console.log("\n=== A. Case 5 resume: session used just now -> resume (keeps context) ===");
__test.setSharedSession({ sessionId: "aaaafresh-session", cursor: 3, cwd: CWD, lastUsedAt: Date.now() });
let r = __test.syncSharedSession(bareUser(), CWD);
check("returns the live sessionId (resume)", r?.sessionId === "aaaafresh-session", JSON.stringify(r));
check("lastUsedAt advanced", (__test.getSharedSession()?.lastUsedAt ?? 0) > Date.now() - 5000);

console.log("\n=== B. Case 5 guard: idle 3h (> 2h default) -> refuse, clean start ===");
__test.setSharedSession({
	sessionId: "bbbbstale-session",
	cursor: 3,
	cwd: CWD,
	lastUsedAt: Date.now() - 3 * 60 * 60 * 1000,
});
r = __test.syncSharedSession(bareUser(), CWD);
check("no resume (sessionId null/undefined)", !(r as any)?.sessionId, JSON.stringify(r));
check("stale sharedSession dropped", __test.getSharedSession() === null, JSON.stringify(__test.getSharedSession()));

console.log("\n=== C. Case 5 guard: legacy session with NO lastUsedAt -> refuse ===");
__test.setSharedSession({ sessionId: "cccclegacy-session", cursor: 3, cwd: CWD });
r = __test.syncSharedSession(bareUser(), CWD);
check("no resume", !(r as any)?.sessionId, JSON.stringify(r));

console.log("\n=== D. Different cwd -> must never resume the other project's session ===");
__test.setSharedSession({ sessionId: "ddddother-proj", cursor: 3, cwd: OTHER_CWD, lastUsedAt: Date.now() });
r = __test.syncSharedSession(bareUser(), CWD);
check("cross-cwd session not resumed", (r as any)?.sessionId !== "ddddother-proj", JSON.stringify(r));

console.log("\n=== E. needsRebuild session -> must not take the Case 5 resume path ===");
__test.setSharedSession({
	sessionId: "eeeerebuild-session",
	cursor: 3,
	cwd: CWD,
	needsRebuild: true,
	lastUsedAt: Date.now(),
});
r = __test.syncSharedSession(bareUser(), CWD);
check("needsRebuild session not resumed", (r as any)?.sessionId !== "eeeerebuild-session", JSON.stringify(r));

console.log("\n=== F. Reentrant (subagent) call -> must not hijack the parent session ===");
__test.setSharedSession({ sessionId: "ffffparent-session", cursor: 3, cwd: CWD, lastUsedAt: Date.now() });
r = __test.syncSharedSession(bareUser(), CWD, undefined, undefined, true);
check("reentrant call not resumed", (r as any)?.sessionId !== "ffffparent-session", JSON.stringify(r));

console.log("\n=== G. Env override: CODEBUDDY_SDK_RESUME_MAX_IDLE_MS=1000 makes even a fresh session stale ===");
process.env.CODEBUDDY_SDK_RESUME_MAX_IDLE_MS = "1000";
__test.setSharedSession({
	sessionId: "ggggshort-window",
	cursor: 3,
	cwd: CWD,
	lastUsedAt: Date.now() - 5000, // 5s idle > 1s window
});
r = __test.syncSharedSession(bareUser(), CWD);
check("env override honored (refused)", !(r as any)?.sessionId, JSON.stringify(r));
delete process.env.CODEBUDDY_SDK_RESUME_MAX_IDLE_MS;

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"}  —  pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
