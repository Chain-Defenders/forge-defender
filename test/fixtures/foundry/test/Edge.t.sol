// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Cases real projects have: overloaded tests (one item, two results) and a setUp that fails.

contract OverloadTest {
    function test_Over() public pure {}

    function test_Over(uint8 x) public pure {
        require(x < 200, "overload too big");
    }
}

contract SetUpFailsTest {
    function setUp() public pure {
        revert("setup broke");
    }

    function test_NeverRuns() public pure {}
}
