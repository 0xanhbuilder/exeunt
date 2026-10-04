// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChainedPriceFeed} from "../../src/shared/oracle/ChainedPriceFeed.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {IPriceFeed} from "../../src/shared/interfaces/IPriceFeed.sol";
import {FixedMorphoOracle} from "../../src/testnet/FixedMorphoOracle.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {MockPriceFeed} from "../utils/MockPriceFeed.sol";

contract FeedsTest is Test {
    function setUp() public {
        vm.warp(1_780_000_000);
    }

    function test_chained_wstEthUsd() public {
        MockPriceFeed wstEthEth = new MockPriceFeed(1.2318e18, 18);
        MockPriceFeed ethUsd = new MockPriceFeed(2_353.89e8, 8);
        ChainedPriceFeed f = new ChainedPriceFeed(IPriceFeed(address(wstEthEth)), IPriceFeed(address(ethUsd)));
        (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        assertEq(f.decimals(), 8);
        assertEq(answer, 2_899_521_702_00); // 1.2318 * 2353.89 = 2899.521702
        assertEq(updatedAt, block.timestamp);
    }

    function test_chained_reportsOlderUpdate() public {
        MockPriceFeed a = new MockPriceFeed(1e18, 18);
        MockPriceFeed b = new MockPriceFeed(1e8, 8);
        a.setUpdatedAt(block.timestamp - 5 hours);
        ChainedPriceFeed f = new ChainedPriceFeed(IPriceFeed(address(a)), IPriceFeed(address(b)));
        (,,, uint256 updatedAt,) = f.latestRoundData();
        assertEq(updatedAt, block.timestamp - 5 hours);
    }

    function test_chained_nonPositiveLegGivesZero() public {
        MockPriceFeed a = new MockPriceFeed(0, 18);
        MockPriceFeed b = new MockPriceFeed(1e8, 8);
        ChainedPriceFeed f = new ChainedPriceFeed(IPriceFeed(address(a)), IPriceFeed(address(b)));
        (, int256 answer,,,) = f.latestRoundData();
        assertEq(answer, 0);
    }

    function test_fixedFeed_rejectsZero() public {
        vm.expectRevert(bytes("price"));
        new FixedPriceFeed(0, 8);
    }

    function test_fixedMorphoOracle() public {
        assertEq(new FixedMorphoOracle(1e24).price(), 1e24);
        vm.expectRevert(bytes("price"));
        new FixedMorphoOracle(0);
    }

    function test_testToken_mintLimit() public {
        TestToken t = new TestToken("Simulated USDe", "sUSDe-sim", 18, 1_000 ether);
        assertEq(t.decimals(), 18);
        t.mint(address(this), 1_000 ether);
        assertEq(t.balanceOf(address(this)), 1_000 ether);
        vm.expectRevert(TestToken.MintLimit.selector);
        t.mint(address(this), 1_000 ether + 1);
    }
}
