import * as path from "node:path";
import * as fs from "node:fs";
import Mocha from "mocha";

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", timeout: 180_000, color: true });
  for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort()) {
    mocha.addFile(path.join(__dirname, f));
  }
  const grep = process.env.FORGEDEFENDER_TEST_GREP;
  if (grep) mocha.grep(grep);
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
