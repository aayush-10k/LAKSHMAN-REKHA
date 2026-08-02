// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {INRx} from "../src/INRx.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract INRxTest is Test {
    INRx internal token;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.prank(owner);
        token = new INRx(owner);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Rekha Rupee");
        assertEq(token.symbol(), "INRx");
        assertEq(token.decimals(), 2);
    }

    function test_ownerMintAndTransfer() public {
        // ₹9,400 == 940000 paise
        vm.prank(owner);
        token.mint(alice, 940000);
        assertEq(token.balanceOf(alice), 940000);

        vm.prank(alice);
        token.transfer(bob, 40000);

        assertEq(token.balanceOf(alice), 900000);
        assertEq(token.balanceOf(bob), 40000);
    }

    function test_nonOwnerCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        token.mint(alice, 1);
    }
}
