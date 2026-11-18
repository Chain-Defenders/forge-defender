import * as assert from "node:assert";
import * as os from "node:os";
import { exec, killAll } from "../../src/core/exec";

suite("exec", () => {
  test("a timeout is reported as timed out, not cancelled", async () => {
    const r = await exec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: os.tmpdir(), timeoutMs: 200 });
    assert.strictEqual(r.timedOut, true);
    assert.ok(!r.cancelled);
  });

  test("killAll stops what is still running", async () => {
    const started = Date.now();
    const pending = exec(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: os.tmpdir() });
    setTimeout(killAll, 200);
    const r = await pending;
    assert.strictEqual(r.cancelled, true);
    assert.ok(Date.now() - started < 5000);
  });

  test("a missing program is not found", async () => {
    const r = await exec("forgedefender-no-such-tool", [], { cwd: os.tmpdir() });
    assert.strictEqual(r.notFound, true);
  });
});
