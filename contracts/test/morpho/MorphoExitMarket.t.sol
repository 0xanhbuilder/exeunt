// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";

contract MorphoExitMarketTest is MorphoBase {
    function test_setup_poolIsFrozen() public view {
        ExitMarket.Capacity memory c = market.capacity();
        assertEq(c.withdrawable, 0, "withdrawable");
        assertEq(c.utilizationBps, 10_000, "utilization");
        assertEq(c.debtorCapacity, 1_000_000 * USD, "debtor capacity");
        assertApproxEqAbs(c.supplied, 1_000_000 * USD, 1, "supplied");
    }

    /* ------------------------------ sessions ------------------------------ */

    function test_openSession_escrowsShares() public {
        uint256 id = _openSession(100_000 * USD);
        assertTrue(market.isOpen(id));
        assertApproxEqAbs(market.remainingAssets(id), 100_000 * USD, 1);
        assertEq(market.discountOf(id), 100);
        assertEq(vault.balanceOf(address(market)), market.totalSessionUnits());
    }

    function test_discount_risesByStepsUpToCap() public {
        uint256 id = _openSession(10_000 * USD);
        assertEq(market.discountOf(id), 100);
        vm.warp(block.timestamp + 1 hours - 1);
        assertEq(market.discountOf(id), 100);
        vm.warp(block.timestamp + 1);
        assertEq(market.discountOf(id), 150);
        vm.warp(block.timestamp + 100 hours);
        assertEq(market.discountOf(id), 1000);
    }

    function test_withdrawUnsold_anytime_returnsShares() public {
        uint256 before = vault.balanceOf(seller);
        uint256 id = _openSession(50_000 * USD);
        vm.prank(seller);
        market.withdrawUnsold(id, type(uint256).max);
        assertEq(vault.balanceOf(seller), before);
        assertFalse(market.isOpen(id));
        assertEq(market.totalSessionUnits(), 0);
    }

    function test_withdrawUnsold_onlySeller() public {
        uint256 id = _openSession(50_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.NotSeller.selector);
        market.withdrawUnsold(id, 1);
    }

    function test_openSession_rejectsBadParams() public {
        ExitMarket.SessionParams memory p = _defaultParams();
        p.capBps = 6000;
        vm.prank(seller);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e6, p);
        p = _defaultParams();
        p.payMask = 0x04; // only two pay tokens
        vm.prank(seller);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e6, p);
    }

    /* --------------------------- buy and repay ---------------------------- */

    function test_buyAndRepay_wallet_repaysDebtAndKeepsLiquidity() public {
        uint256 id = _openSession(100_000 * USD);
        uint256 debtBefore = _debt(buyer);
        uint256 withdrawableBefore = _withdrawable();
        uint256 sellerUsdg = usdg.balanceOf(seller);

        uint256 assets = 50_000 * USD;
        uint256 price = market.quote(assets, market.discountOf(id), address(usdg));
        assertEq(price, 49_500 * USD, "1% discount");

        vm.startPrank(buyer);
        usdg.approve(address(market), price);
        (uint256 paid, uint256 repaid) = market.buyAndRepay(id, assets, PAY_USDG, price, _venue(false, ""));
        vm.stopPrank();

        assertEq(paid, price);
        assertEq(repaid, assets, "Morpho flash is free");
        assertApproxEqAbs(debtBefore - _debt(buyer), assets, 1, "debt repaid at face value");
        assertEq(usdg.balanceOf(seller) - sellerUsdg, price, "seller paid");
        assertEq(_withdrawable(), withdrawableBefore, "withdrawable liquidity unchanged");
        assertApproxEqAbs(market.remainingAssets(id), 50_000 * USD, 2, "remaining");
        assertEq(vault.balanceOf(address(market)), market.totalSessionUnits(), "units accounted");
    }

    function test_buyAndRepay_payInOtherToken() public {
        uint256 id = _openSession(20_000 * USD);
        vm.warp(block.timestamp + 2 hours); // 2% discount
        uint256 assets = 10_000 * USD;
        uint256 price = market.quote(assets, 200, address(usde));
        assertEq(price, 9_800 ether);
        usde.mint(buyer, price);
        vm.startPrank(buyer);
        usde.approve(address(market), price);
        market.buyAndRepay(id, assets, PAY_USDE, price, _venue(false, ""));
        vm.stopPrank();
        assertEq(usde.balanceOf(seller), price);
    }

    function test_buyAndRepay_smallFlashLiquidity_loops() public {
        _withdrawFlashMarket(190_000 * USD); // 10k USDG left to flash
        uint256 id = _openSession(100_000 * USD);
        uint256 debtBefore = _debt(buyer);
        uint256 assets = 95_000 * USD;
        uint256 price = market.quote(assets, 100, address(usdg));
        vm.startPrank(buyer);
        usdg.approve(address(market), price);
        market.buyAndRepay(id, assets, PAY_USDG, price, _venue(false, ""));
        vm.stopPrank();
        assertApproxEqAbs(debtBefore - _debt(buyer), assets, 10, "debt repaid over 10 rounds");
        assertEq(_withdrawable(), 0);
    }

    function test_buyAndRepay_revertsWithoutFlashLiquidity() public {
        _withdrawFlashMarket(200_000 * USD);
        uint256 id = _openSession(10_000 * USD);
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        vm.expectRevert(MorphoVaultExitMarket.NoFlashLiquidity.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDG, type(uint256).max, _venue(false, ""));
        vm.stopPrank();
    }

    function test_buyAndRepay_revertsWhenFlashTooSmallForLoopCap() public {
        _withdrawFlashMarket(200_000 * USD - 100 * USD); // 100 USDG left
        uint256 id = _openSession(10_000 * USD);
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        vm.expectRevert();
        market.buyAndRepay(id, 10_000 * USD - 10, PAY_USDG, type(uint256).max, _venue(false, ""));
        vm.stopPrank();
    }

    function test_buyAndRepay_reverts_priceAboveMax() public {
        uint256 id = _openSession(10_000 * USD);
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExitMarket.PriceTooHigh.selector, 990 * USD, 989 * USD));
        market.buyAndRepay(id, 1_000 * USD, PAY_USDG, 989 * USD, _venue(false, ""));
        vm.stopPrank();
    }

    function test_buyAndRepay_reverts_debtTooSmall() public {
        uint256 id = _openSession(500_000 * USD);
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        vm.expectRevert();
        market.buyAndRepay(id, 400_000 * USD, PAY_USDG, type(uint256).max, _venue(false, ""));
        vm.stopPrank();
    }

    function test_buyAndRepay_reverts_payTokenNotAccepted() public {
        ExitMarket.SessionParams memory p = _defaultParams();
        p.payMask = 0x01; // USDG only
        uint256 id = _openSession(10_000 * USD, p);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.PayTokenNotAccepted.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDE, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_afterSessionEnds() public {
        uint256 id = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 7 days);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.SessionClosed.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDG, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_reverts_moreThanSession() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.NotEnoughUnits.selector);
        market.buyAndRepay(id, 10_001 * USD, PAY_USDG, type(uint256).max, _venue(false, ""));
    }

    function test_buyAndRepay_wholeSession() public {
        uint256 id = _openSession(10_000 * USD);
        uint256 assets = market.remainingAssets(id);
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        market.buyAndRepay(id, assets, PAY_USDG, type(uint256).max, _venue(false, ""));
        vm.stopPrank();
        assertLe(market.remainingAssets(id), 1);
    }

    function test_buyAndRepay_forceDeallocate_chargesPenaltyToSessionNotBuyer() public {
        _timelocked(vault, abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (s.adapter, 0.01e18)));
        vault.setLiquidityAdapterAndData(address(0), ""); // only forced deallocation can free liquidity
        uint256 id = _openSession(20_000 * USD);
        uint256 debtBefore = _debt(buyer);
        uint256 assets = 10_100 * USD;
        vm.startPrank(buyer);
        usdg.approve(address(market), type(uint256).max);
        (, uint256 repaid) = market.buyAndRepay(id, assets, PAY_USDG, type(uint256).max, _venue(true, ""));
        vm.stopPrank();
        assertEq(repaid, 10_000 * USD, "assets / (1 + penalty)");
        assertApproxEqAbs(debtBefore - _debt(buyer), repaid, 1);
        assertApproxEqAbs(market.remainingAssets(id), 9_900 * USD, 5);
        assertEq(_withdrawable(), 0, "liquidity unchanged");
    }

    function test_buyAndRepay_rejectsMarketTheVaultDoesNotSupply() public {
        uint256 id = _openSession(10_000 * USD);
        // The flash market has USDG debt-free liquidity but no vault allocation.
        bytes memory venue = abi.encode(s.flashMarket, false, bytes(""));
        vm.prank(buyer);
        vm.expectRevert(MorphoVaultExitMarket.WrongMarket.selector);
        market.buyAndRepay(id, 1_000 * USD, PAY_USDG, type(uint256).max, venue);
    }

    /* ---------------------- flash mode (collateral) ----------------------- */

    function test_buyWithCollateral_paysSellerFromFreedCollateral() public {
        uint256 id = _openSession(100_000 * USD);
        vm.warp(block.timestamp + 4 hours); // 3%
        uint256 assets = 60_000 * USD;
        uint256 price = market.quote(assets, 300, address(usde));
        uint256 debtBefore = _debt(buyer);
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));

        vm.prank(buyer);
        (uint256 paid, uint256 repaid) = market.buyAndRepayWithCollateral(id, assets, PAY_USDE, price, venue);

        assertEq(paid, 58_200 ether);
        assertEq(repaid, assets);
        assertEq(usde.balanceOf(seller), paid, "seller got collateral");
        assertApproxEqAbs(debtBefore - _debt(buyer), assets, 1);
        assertFalse(morpho.isAuthorized(buyer, address(market)), "authorization revoked");
        assertEq(usdg.balanceOf(buyer), 300_000 * USD, "buyer spent no cash");
        assertEq(_withdrawable(), 0);
    }

    function test_buyWithCollateral_healthImproves() public {
        uint256 id = _openSession(100_000 * USD);
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        // max borrow 344k on 300k debt
        uint256 before = 344_000 * USD * 1e18 / _debt(buyer);
        vm.prank(buyer);
        market.buyAndRepayWithCollateral(id, 100_000 * USD, PAY_USDE, type(uint256).max, venue);
        uint256 collateralLeft = 400_000 ether - market.quote(100_000 * USD, 100, address(usde));
        uint256 afterHealth = (collateralLeft / 1e12) * 86 / 100 * 1e18 / _debt(buyer);
        assertGt(afterHealth, before);
    }

    function test_buyWithCollateral_requiresSignedRevoke() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(MorphoVaultExitMarket.BadAuthorization.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_USDE, type(uint256).max, _venue(false, ""));
    }

    function test_buyWithCollateral_rejectsUnderlyingAsPayment() public {
        uint256 id = _openSession(10_000 * USD);
        vm.prank(buyer);
        vm.expectRevert(ExitMarket.SamePaymentAsset.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_USDG, type(uint256).max, _venue(false, ""));
    }

    function test_buyWithCollateral_cannotUseSomeoneElsesSignature() public {
        uint256 id = _openSession(10_000 * USD);
        bytes memory venue = _venue(false, _authBundle(buyerKey, buyer));
        vm.prank(whale);
        vm.expectRevert(MorphoVaultExitMarket.BadAuthorization.selector);
        market.buyAndRepayWithCollateral(id, 1_000 * USD, PAY_USDE, type(uint256).max, venue);
    }

    /* ----------------------------- limit bids ----------------------------- */

    function _placeBid(address who, uint16 minDiscount, uint256 maxAssets, uint256 escrow) internal returns (uint256) {
        usdg.mint(who, escrow);
        vm.startPrank(who);
        usdg.approve(address(market), escrow);
        uint256 id = market.placeBid(minDiscount, PAY_USDG, maxAssets, escrow);
        vm.stopPrank();
        return id;
    }

    function test_placeBid_escrowsAndCountsCapacity() public {
        _placeBid(bidder, 300, 100_000 * USD, 48_500 * USD);
        assertEq(market.totalEscrow(address(usdg)), 48_500 * USD);
        assertEq(market.bidCapacityAt(299), 0);
        assertEq(market.bidCapacityAt(300), 50_000 * USD);
    }

    function test_cancelBid_refundsImmediately() public {
        uint256 id = _placeBid(bidder, 300, 100_000 * USD, 10_000 * USD);
        vm.prank(bidder);
        market.cancelBid(id);
        assertEq(usdg.balanceOf(bidder), 10_000 * USD);
        assertEq(market.totalEscrow(address(usdg)), 0);
        assertEq(market.activeBidIds().length, 0);
    }

    function test_cancelBid_onlyBidder() public {
        uint256 id = _placeBid(bidder, 300, 100_000 * USD, 10_000 * USD);
        vm.prank(seller);
        vm.expectRevert(ExitMarket.NotBidder.selector);
        market.cancelBid(id);
    }

    function test_sellNow_fillsBestBidsFirstAtTheirPrice() public {
        uint256 cheap = _placeBid(bidder, 200, 30_000 * USD, 29_400 * USD);
        uint256 deep = _placeBid(keeper, 800, 100_000 * USD, 92_000 * USD);
        uint256[] memory ids = new uint256[](2);
        ids[0] = cheap;
        ids[1] = deep;
        uint256 sellerUsdg = usdg.balanceOf(seller);
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (uint256 filled, uint256[] memory paid) = market.sellNow(50_000 * USD, ids, 1000, 0x01, 50_000 * USD);
        vm.stopPrank();
        assertEq(filled, 50_000 * USD);
        assertEq(paid[0], 29_400 * USD);
        assertEq(paid[1], 18_400 * USD);
        assertEq(usdg.balanceOf(seller) - sellerUsdg, 47_800 * USD);
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(bidder)), 30_000 * USD, 2);
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(keeper)), 20_000 * USD, 2);
        (address cheapBidder,,,,) = market.bids(cheap);
        assertEq(cheapBidder, address(0), "exhausted bid closed");
    }

    function test_sellNow_skipsBidsAboveSellerLimit() public {
        uint256 deep = _placeBid(keeper, 800, 100_000 * USD, 92_000 * USD);
        uint256[] memory ids = new uint256[](1);
        ids[0] = deep;
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExitMarket.InsufficientFill.selector, 0, 1));
        market.sellNow(50_000 * USD, ids, 500, 0x01, 1);
        vm.stopPrank();
    }

    function test_matchBid_whenSessionReachesBidDiscount() public {
        uint256 bidId = _placeBid(bidder, 300, 100_000 * USD, 97_000 * USD);
        uint256 id = _openSession(40_000 * USD);
        vm.prank(keeper);
        vm.expectRevert(ExitMarket.DiscountBelowBid.selector);
        market.matchBid(id, bidId, type(uint256).max);

        vm.warp(block.timestamp + 4 hours); // 3%
        // Escrowed shares keep earning interest while the session is open.
        uint256 remaining = market.remainingAssets(id);
        assertGt(remaining, 40_000 * USD);
        vm.prank(keeper);
        (uint256 filled, uint256 paid) = market.matchBid(id, bidId, type(uint256).max);
        assertEq(filled, remaining);
        assertEq(paid, market.quote(remaining, 300, address(usdg)));
        assertEq(usdg.balanceOf(seller), paid);
        assertApproxEqAbs(vault.previewRedeem(vault.balanceOf(bidder)), remaining, 3);
        assertLe(market.remainingAssets(id), 1);
    }

    function test_matchBid_paysSessionPriceNotWorse() public {
        uint256 bidId = _placeBid(bidder, 200, 100_000 * USD, 97_000 * USD);
        uint256 id = _openSession(10_000 * USD);
        vm.warp(block.timestamp + 10 hours); // session at 6%, bid accepts >= 2%
        (uint256 filled, uint256 paid) = market.matchBid(id, bidId, type(uint256).max);
        assertApproxEqAbs(paid, filled * 94 / 100, 1, "fills at the session's current discount");
    }

    function test_bid_neverFillsBelowItsDiscount(uint16 sessionStart) public {
        sessionStart = uint16(bound(sessionStart, 0, 299));
        uint256 bidId = _placeBid(bidder, 300, 100_000 * USD, 97_000 * USD);
        ExitMarket.SessionParams memory p = _defaultParams();
        p.startBps = sessionStart;
        p.stepBps = 0;
        uint256 id = _openSession(10_000 * USD, p);
        vm.expectRevert(ExitMarket.DiscountBelowBid.selector);
        market.matchBid(id, bidId, type(uint256).max);
    }

    /* ------------------------------ recovery ------------------------------ */

    function test_redeemReceipt_onlyWhenLiquid_neverTouchesEscrow() public {
        _openSession(100_000 * USD);
        uint256 shares = vault.previewWithdraw(10_000 * USD);
        vm.prank(seller);
        vault.transfer(bidder, shares);
        vm.startPrank(bidder);
        vault.approve(address(market), type(uint256).max);
        vm.expectRevert();
        market.redeemReceipt(10_000 * USD, bidder);
        vm.stopPrank();

        // Whale repays part of its loan: liquidity returns.
        vm.startPrank(whale);
        usdg.approve(address(morpho), 50_000 * USD);
        morpho.repay(s.earnMarket, 50_000 * USD, 0, whale, "");
        vm.stopPrank();

        uint256 escrowBefore = market.totalSessionUnits();
        vm.prank(bidder);
        market.redeemReceipt(10_000 * USD, bidder);
        assertEq(usdg.balanceOf(bidder), 10_000 * USD);
        assertEq(market.totalSessionUnits(), escrowBefore);
        assertGe(vault.balanceOf(address(market)), market.totalSessionUnits());
    }
}
