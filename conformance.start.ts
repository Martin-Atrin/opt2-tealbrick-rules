// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots the app with
// the env the suite gives it (fake bridge, enrolment code, TB_KEK, data dir) and drives it like the bridge does. The SDK
// listens on the suite's free port (TBCONF_PORT) or manifest `runtime.port` (SDK-API §13); `backupNow` lets the suite run the backup/restore round-trip (A7).
// Test roots (C63; the suite default since spec 0.1.12, `--test-roots` kept for older suites): the suite passes TEST
// Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS; only this harness reads it and hands them to startApp. Required: the SDK
// refuses every slice whose key-set statement is not signed by a root it pins. Production never reads that variable.
// The suite also sets TB_DATA_EPHEMERAL=1 (its temp data dirs are not volumes; SDK 0.1.12 mount check) — tests only.
import { startApp } from "@opt2-tealbrick/miniapp-sdk";
import { app, manifest } from "./src/app.ts";

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  // Port: the suite's free port (TBCONF_PORT, conformance ≥ 0.1.13), else manifest runtime.port.
  const harness = {
    ...(env.TBCONF_PORTAL_ROOT_KEYS ? { portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } : {}),
    port: env.TBCONF_PORT ? Number(env.TBCONF_PORT) : manifest.runtime.port,
  } as Parameters<typeof startApp>[2];
  const running = await startApp(app, env, harness);
  return {
    url: `http://127.0.0.1:${running.port}`,
    stop: () => running.stop(),
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
