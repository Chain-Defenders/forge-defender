// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Counter} from "../src/Counter.sol";

// No forge-std, so the fixture builds without dependencies: asserts are plain requires.
abstract contract BaseTest {
    Counter internal counter;

    function setUp() public virtual {
        counter = new Counter();
    }

    function test_InheritedPasses() public view {
        require(counter.number() == 0, "starts at zero");
    }
}
