// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Counter} from "../src/Counter.sol";

interface Vm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract DeployScript {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (Counter c) {
        vm.startBroadcast();
        c = new Counter();
        vm.stopBroadcast();
    }
}
