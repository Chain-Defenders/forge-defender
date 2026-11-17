import * as assert from "node:assert";
import { compareVersions, inRange, parseVersion } from "../../src/security/semver";

suite("security: version ranges", () => {
  test("reads plain, v-prefixed, short and git describe versions", () => {
    assert.deepStrictEqual(parseVersion("4.9.0")?.nums, [4, 9, 0]);
    assert.deepStrictEqual(parseVersion("v5.0.2")?.nums, [5, 0, 2]);
    assert.deepStrictEqual(parseVersion("0.30")?.nums, [0, 30, 0]);
    assert.deepStrictEqual(parseVersion("v4.8.0-12-gabc1234")?.nums, [4, 8, 0]);
    assert.deepStrictEqual(parseVersion("v4.8.0-12-gabc1234")?.pre, []);
    assert.deepStrictEqual(parseVersion("5.0.0-rc.1")?.pre, ["rc", "1"]);
    assert.strictEqual(parseVersion("main"), undefined);
  });

  test("orders pre-releases before their release", () => {
    const v = (s: string) => parseVersion(s)!;
    assert.strictEqual(compareVersions(v("5.0.0-rc.0"), v("5.0.0")), -1);
    assert.strictEqual(compareVersions(v("5.0.0-rc.2"), v("5.0.0-rc.10")), -1);
    assert.strictEqual(compareVersions(v("4.10.0"), v("4.9.9")), 1);
    assert.strictEqual(compareVersions(v("1.0.0"), v("1.0")), 0);
  });

  test("matches GHSA ranges", () => {
    assert.ok(inRange("4.0.0", ">= 4.0.0, < 4.4.1"));
    assert.ok(inRange("4.4.0", ">= 4.0.0, < 4.4.1"));
    assert.ok(!inRange("4.4.1", ">= 4.0.0, < 4.4.1"));
    assert.ok(!inRange("3.4.2", ">= 4.0.0, < 4.4.1"));
    assert.ok(inRange("4.9.4", "= 4.9.4"));
    assert.ok(!inRange("4.9.5", "= 4.9.4"));
    assert.ok(inRange("1.0.0-rc.1", "= 1.0.0-rc.1"));
    assert.ok(inRange("5.0.0-rc.0", ">= 5.0.0-rc.0, < 5.0.2"));
    assert.ok(inRange("5.0.1", ">= 5.0.0-rc.0, < 5.0.2"));
    assert.ok(inRange("0.9.0", "< 1.0.2"));
    assert.ok(!inRange("garbage", "< 1.0.2"));
    assert.ok(!inRange("1.0.0", ""));
  });
});
