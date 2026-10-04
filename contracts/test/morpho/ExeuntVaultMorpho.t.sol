// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {ExeuntVault} from "../../src/vault/ExeuntVault.sol";

contract ExeuntVaultMorphoTest is MorphoBase {
    ExeuntVault internal ev;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        ev = new ExeuntVault("Exeunt Vault USDG", "xUSDG", usdg, markets, minD, maxShare);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(ev), amount);
        shares = ev.deposit(amount, who);
        vm.stopPrank();
    }

    function _activeBid() internal view returns (uint256 id, uint256 escrow, uint256 maxAssets, uint16 minD) {
        id = ev.bidOf(0);
        (, minD,, maxAssets, escrow) = market.bids(id);
    }

    function test_deposit_placesRuleBasedBid() public {
        _deposit(alice, 100_000 * USD);
        (uint256 id, uint256 escrow, uint256 maxAssets, uint16 minD) = _activeBid();
        assertGt(id, 0);
        assertEq(minD, 300, "min discount");
        assertEq(escrow, 20_000 * USD, "20% of capital");
        assertEq(maxAssets, 20_000 * USD);
        assertEq(ev.totalAssets(), 100_000 * USD);
        assertEq(ev.idleAssets(), 100_000 * USD);
        assertEq(usdg.balanceOf(address(ev)), 80_000 * USD, "rest stays idle outside the pool");
    }

    function test_vaultCapitalNeverEntersProtectedPool() public {
        _deposit(alice, 100_000 * USD);
        assertEq(vault.balanceOf(address(ev)), 0, "no Earn shares minted by deposits");
    }

    function test_sellerSellsIntoVault_vaultHoldsReceipts() public {
        _deposit(alice, 100_000 * USD);
        (uint256 bidId,,,) = _activeBid();
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(30_000 * USD, ids, 500, 0x01, 1);
        vm.stopPrank();
        assertEq(filled, 20_000 * USD, "capped at 20%");
        assertEq(usdg.balanceOf(seller), 19_400 * USD, "3% discount");
        assertApproxEqAbs(ev.heldAssets(0), 20_000 * USD, 2);
        assertApproxEqAbs(ev.totalAssets(), 100_600 * USD, 2, "discount accrues to depositors");

        ev.refreshBids();
        (, uint256 escrow,,) = _activeBid();
        // cap 20% of 100.6k = 20.12k minus 20k held
        assertApproxEqAbs(escrow, 120 * USD, 2);
    }

    function test_redeem_inKind_beforeRecovery() public {
        uint256 shares = _deposit(alice, 100_000 * USD);
        _deposit(bob, 100_000 * USD);
        (uint256 bidId,,,) = _activeBid();
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(40_000 * USD, ids, 500, 0x01, 1);
        vm.stopPrank();

        uint256 earnShares = vault.balanceOf(address(ev));
        vm.prank(alice);
        (uint256 assets, uint256[] memory receipts) = ev.redeem(shares, alice, alice);
        assertApproxEqRel(assets, 80_600 * USD, 1e12, "half of idle");
        assertApproxEqRel(receipts[0], earnShares / 2, 1e8, "half of receipts in kind");
        assertLe(receipts[0], earnShares / 2);
        assertEq(vault.balanceOf(alice), receipts[0]);
        assertEq(usdg.balanceOf(alice), assets);
    }

    function test_redeem_allowanceForThirdParty() public {
        uint256 shares = _deposit(alice, 1_000 * USD);
        vm.prank(bob);
        vm.expectRevert();
        ev.redeem(shares, bob, alice);
        vm.prank(alice);
        ev.approve(bob, shares);
        vm.prank(bob);
        ev.redeem(shares, bob, alice);
        assertApproxEqAbs(usdg.balanceOf(bob), 1_000 * USD, 1);
    }

    function test_recover_permissionless_afterPoolUnfreezes() public {
        _deposit(alice, 100_000 * USD);
        (uint256 bidId,,,) = _activeBid();
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        market.sellNow(20_000 * USD, ids, 500, 0x01, 1);
        vm.stopPrank();

        vm.expectRevert();
        ev.recover(0, type(uint256).max);

        vm.startPrank(whale);
        usdg.approve(address(morpho), 100_000 * USD);
        morpho.repay(s.earnMarket, 100_000 * USD, 0, whale, "");
        vm.stopPrank();

        vm.prank(keeper);
        ev.recover(0, type(uint256).max);
        assertLe(ev.heldAssets(0), 1);
        assertApproxEqAbs(ev.totalAssets(), 100_600 * USD, 3, "profit realised in USDG");
    }

    function test_matchBid_sessionHitsVaultBid() public {
        _deposit(alice, 100_000 * USD);
        uint256 sessionId = _openSession(10_000 * USD);
        (uint256 bidId,,,) = _activeBid();
        vm.warp(block.timestamp + 4 hours);
        market.matchBid(sessionId, bidId, type(uint256).max);
        assertGt(ev.heldAssets(0), 10_000 * USD - 1);
    }

    function test_constructor_rejectsDifferentDenomination() public {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        vm.expectRevert(ExeuntVault.BadParams.selector);
        new ExeuntVault("x", "x", usde, markets, minD, maxShare);
    }

    function testFuzz_depositRedeem_noValueCreated(uint96 a, uint96 b) public {
        uint256 x = bound(uint256(a), 1 * USD, 10_000_000 * USD);
        uint256 y = bound(uint256(b), 1 * USD, 10_000_000 * USD);
        uint256 sa = _deposit(alice, x);
        _deposit(bob, y);
        vm.prank(alice);
        (uint256 out,) = ev.redeem(sa, alice, alice);
        assertLe(out, x, "never more than deposited");
        assertApproxEqAbs(out, x, 2, "fair share");
    }
}
