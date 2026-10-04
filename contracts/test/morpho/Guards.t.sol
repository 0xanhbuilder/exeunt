// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {ExeuntVault} from "../../src/vault/ExeuntVault.sol";

/// @dev Every guard path of the market and vault, so reverts are deliberate and specific.
contract GuardsTest is MorphoBase {
    function test_openSession_paramGuards() public {
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        ExitMarket.SessionParams memory p = _defaultParams();
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.openSession(0, p);
        p.startBps = 2000; // above cap
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        p = _defaultParams();
        p.stepInterval = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        p = _defaultParams();
        p.duration = 31 days;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        p = _defaultParams();
        p.duration = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        p = _defaultParams();
        p.payMask = 0;
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.openSession(1e18, p);
        vm.stopPrank();
    }

    function test_withdrawUnsold_amountGuards() public {
        uint256 id = _openSession(1_000 * USD);
        (,,,,,,,, uint256 units) = market.sessions(id);
        vm.startPrank(seller);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.withdrawUnsold(id, 0);
        vm.expectRevert(ExitMarket.NotEnoughUnits.selector);
        market.withdrawUnsold(id, units + 1);
        market.withdrawUnsold(id, units / 2);
        vm.stopPrank();
        assertEq(market.totalSessionUnits(), units - units / 2);
    }

    function test_discountOf_unknownSessionIsZero() public view {
        assertEq(market.discountOf(999), 0);
        assertFalse(market.isOpen(999));
    }

    function test_bidGuards() public {
        vm.startPrank(bidder);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.placeBid(100, 0, 0, 1);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.placeBid(100, 0, 1, 0);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.placeBid(5001, 0, 1, 1);
        vm.expectRevert(ExitMarket.BadParams.selector);
        market.placeBid(100, 2, 1, 1);
        vm.expectRevert(ExitMarket.NotBidder.selector);
        market.cancelBid(42);
        vm.stopPrank();
        assertEq(market.bidCapacity(42, 100), 0);
    }

    function test_matchBid_guards() public {
        uint256 id = _openSession(1_000 * USD);
        vm.expectRevert(ExitMarket.UnknownBid.selector);
        market.matchBid(id, 7, 1);

        usdg.mint(bidder, 1_000 * USD);
        usde.mint(bidder, 1_000 ether);
        vm.startPrank(bidder);
        usdg.approve(address(market), type(uint256).max);
        usde.approve(address(market), type(uint256).max);
        uint256 bidUsde = market.placeBid(0, PAY_USDE, 1_000 * USD, 1_000 ether);
        uint256 bidUsdg = market.placeBid(0, PAY_USDG, 1_000 * USD, 500 * USD);
        vm.stopPrank();

        ExitMarket.SessionParams memory p = _defaultParams();
        p.payMask = 0x01;
        uint256 usdgOnly = _openSession(1_000 * USD, p);
        vm.expectRevert(ExitMarket.PayTokenNotAccepted.selector);
        market.matchBid(usdgOnly, bidUsde, type(uint256).max);

        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.matchBid(usdgOnly, bidUsdg, 0);

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(ExitMarket.SessionClosed.selector);
        market.matchBid(id, bidUsdg, type(uint256).max);
    }

    function test_matchBid_partialByAssetsArgument() public {
        usdg.mint(bidder, 10_000 * USD);
        vm.startPrank(bidder);
        usdg.approve(address(market), type(uint256).max);
        uint256 bidId = market.placeBid(100, PAY_USDG, 10_000 * USD, 9_900 * USD);
        vm.stopPrank();
        uint256 id = _openSession(5_000 * USD);
        (uint256 filled,) = market.matchBid(id, bidId, 1_000 * USD);
        assertEq(filled, 1_000 * USD);
        assertApproxEqAbs(market.remainingAssets(id), 4_000 * USD, 2);
    }

    function test_sellNow_zeroAndSkips() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 77; // unknown bid is skipped
        vm.startPrank(seller);
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.sellNow(0, ids, 100, 0x01, 0);
        (uint256 filled,) = market.sellNow(1_000 * USD, ids, 100, 0x01, 0);
        vm.stopPrank();
        assertEq(filled, 0);
    }

    function test_redeemReceipt_zero() public {
        vm.expectRevert(ExitMarket.ZeroAmount.selector);
        market.redeemReceipt(0, address(this));
    }

    function test_flashCallback_cannotBeCalledDirectly() public {
        vm.expectRevert(MorphoVaultExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
        vm.prank(address(morpho));
        vm.expectRevert(MorphoVaultExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
    }

    function test_views() public {
        assertEq(market.payTokens().length, 2);
        _openSession(1_000 * USD);
        ExitMarket.Capacity memory c = market.capacity();
        assertApproxEqAbs(c.sessionAssets, 1_000 * USD, 2);
        assertEq(market.receiptValue(vault.balanceOf(address(market))), market.remainingAssets(1));
    }

    function test_constructor_rejectsForeignAdapter() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(usdg);
        vm.expectRevert();
        new MorphoVaultExitMarket(morpho, vault, address(0xBEEF), prices, tokens);
    }

    /* ------------------------------- vault ------------------------------- */

    function _vault() internal returns (ExeuntVault ev) {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        ev = new ExeuntVault("Exeunt Vault USDG", "xUSDG", usdg, markets, minD, maxShare);
    }

    function test_vault_guardsAndViews() public {
        ExeuntVault ev = _vault();
        assertEq(ev.decimals(), 9);
        assertEq(ev.strategiesLength(), 1);
        assertEq(address(ev.strategy(0).market), address(market));
        vm.expectRevert(ExeuntVault.ZeroAmount.selector);
        ev.deposit(0, address(this));
        vm.expectRevert(ExeuntVault.ZeroShares.selector);
        ev.redeem(0, address(this), address(this));
        vm.expectRevert(ExeuntVault.ZeroAmount.selector);
        ev.recover(0, 1);
        ev.refreshBids(); // nothing to bid with: no-op
        assertEq(ev.bidOf(0), 0);
    }

    function test_vault_constructorGuards() public {
        ExitMarket[] memory markets = new ExitMarket[](2);
        markets[0] = market;
        markets[1] = market;
        uint16[] memory minD = new uint16[](2);
        uint16[] memory maxShare = new uint16[](2);
        maxShare[0] = 1000;
        maxShare[1] = 1000;
        vm.expectRevert(ExeuntVault.BadParams.selector); // duplicate receipt
        new ExeuntVault("x", "x", usdg, markets, minD, maxShare);
        uint16[] memory shortShare = new uint16[](1);
        vm.expectRevert(ExeuntVault.BadParams.selector); // length mismatch
        new ExeuntVault("x", "x", usdg, markets, minD, shortShare);
        ExitMarket[] memory one = new ExitMarket[](1);
        one[0] = market;
        uint16[] memory zeroShare = new uint16[](1);
        uint16[] memory d1 = new uint16[](1);
        vm.expectRevert(ExeuntVault.BadParams.selector); // zero max share
        new ExeuntVault("x", "x", usdg, one, d1, zeroShare);
    }

    function test_vault_bidClosedByAFullFillIsHandled() public {
        ExeuntVault ev = _vault();
        usdg.mint(address(this), 10_000 * USD);
        usdg.approve(address(ev), type(uint256).max);
        ev.deposit(10_000 * USD, address(this));
        uint256 bidId = ev.bidOf(0);
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(100_000 * USD, ids, 500, 0x01, 0);
        vm.stopPrank();
        (address bidderNow,,,,) = market.bids(bidId);
        assertEq(bidderNow, address(0), "exhausted bid closed by the market");
        ev.refreshBids(); // must skip the closed bid instead of reverting
        assertGt(ev.heldAssets(0), 0);
    }
}
