// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title A counter used by ForgeDefender's own tests
contract Counter {
    uint256 public number;
    address public owner;

    error TooBig(uint256 value);
    event Set(uint256 indexed value);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Sets the number, up to 1000
    function setNumber(uint256 newNumber) public {
        if (newNumber > 1000) revert TooBig(newNumber);
        number = newNumber;
        emit Set(newNumber);
    }

    function increment() public {
        number++;
    }

    function untested(uint256 a) external pure returns (uint256) {
        return a * 2;
    }
}
