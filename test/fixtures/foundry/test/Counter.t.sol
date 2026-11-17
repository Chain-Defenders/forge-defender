// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseTest} from "./Base.t.sol";

contract CounterTest is BaseTest {
    function test_Increment() public {
        counter.increment();
        require(counter.number() == 1, "one after increment");
    }

    function test_FailsOnPurpose() public {
        counter.setNumber(5);
        require(counter.number() == 6, "number should be six");
    }

    function testFuzz_SetNumber(uint256 x) public {
        counter.setNumber(x);
        require(counter.number() == x, "set");
    }

    // A comment mentioning function test_NotATest() public {} must not create a test.
    function helper() internal pure returns (uint256) {
        return 1;
    }
}

contract InvariantCounterTest is BaseTest {
    function invariant_Small() public view {
        require(counter.number() < 3, "stays small");
    }
}
