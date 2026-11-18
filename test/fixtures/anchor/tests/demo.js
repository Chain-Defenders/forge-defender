const anchor = require("@coral-xyz/anchor");
const { assert } = require("chai");

describe("demo", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  it("initializes", async () => {
    assert.ok(true);
  });

  describe("increment", () => {
    it("adds", async () => {});

    it.skip("is skipped", async () => {});
  });
});
