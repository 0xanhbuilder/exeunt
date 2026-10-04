// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {MockPriceFeed} from "../utils/MockPriceFeed.sol";

/// @dev Pricing properties with a volatile payment token (sim-USDe priced away from $1).
contract PricingTest is MorphoBase {
    MockPriceFeed internal usdeFeed;

    function setUp() public override {
        super.setUp();
        usdeFeed = new MockPriceFeed(1.17e8, 8);
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(usde);
        address[] memory feeds = new address[](2);
        feeds[0] = address(new MockPriceFeed(0.9998e8, 8));
        feeds[1] = address(usdeFeed);
        prices = new PriceRouter(tokens, feeds, 1 days);
        market = new MorphoVaultExitMarket(morpho, vault, s.adapter, prices, tokens);
    }

    function testFuzz_quote_neverUndercharges(uint96 assets, uint16 d, uint64 px) public {
        uint256 a = bound(uint256(assets), 1, 1e15 * USD);
        uint16 disc = uint16(bound(d, 0, 5000));
        usdeFeed.set(int256(bound(uint256(px), 1e6, 1e12)));
        uint256 price = market.quote(a, disc, address(usde));
        assertGe(market.assetsFor(price, disc, address(usde)), a, "paying the quote buys at least `assets`");
    }

    function testFuzz_assetsFor_neverOverspendsEscrow(uint96 escrow, uint16 d, uint64 px) public {
        uint256 e = bound(uint256(escrow), 1, 1e27);
        uint16 disc = uint16(bound(d, 0, 5000));
        usdeFeed.set(int256(bound(uint256(px), 1e6, 1e12)));
        uint256 a = market.assetsFor(e, disc, address(usde));
        if (a == 0) return;
        // Within one unit of rounding in the pay token.
        assertLe(market.quote(a, disc, address(usde)), e + 1, "bid capacity is fully funded");
    }

    function testFuzz_higherDiscount_cheaper(uint96 assets, uint16 d1, uint16 d2) public view {
        uint256 a = bound(uint256(assets), 1, 1e15 * USD);
        uint16 lo = uint16(bound(d1, 0, 5000));
        uint16 hi = uint16(bound(d2, lo, 5000));
        assertLe(market.quote(a, hi, address(usdg)), market.quote(a, lo, address(usdg)));
        assertLe(market.quote(a, hi, address(usde)), market.quote(a, lo, address(usde)));
    }

    function test_quote_sameAssetIgnoresOracle() public view {
        assertEq(market.quote(1_000 * USD, 250, address(usdg)), 975 * USD);
    }

    function test_quote_crossAsset() public view {
        // 1,000 USDG face at 2.5% = 975 USDG worth; USDG $0.9998, USDe $1.17
        uint256 expected = uint256(975 * 1e18) * 0.9998e8 / 1.17e8;
        assertApproxEqAbs(market.quote(1_000 * USD, 250, address(usde)), expected, 1);
    }

    function test_constructor_requiresFeeds() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = makeAddr("noFeed");
        vm.expectRevert(ExitMarket.BadParams.selector);
        new MorphoVaultExitMarket(morpho, vault, s.adapter, prices, tokens);
    }

    function test_constructor_rejectsDuplicatePayTokens() public {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(usdg);
        vm.expectRevert(ExitMarket.BadParams.selector);
        new MorphoVaultExitMarket(morpho, vault, s.adapter, prices, tokens);
    }
}
