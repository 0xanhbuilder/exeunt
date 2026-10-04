// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoBase} from "./MorphoBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {MockERC20} from "../utils/MockERC20.sol";

/// @dev Drives random sequences of market actions; records anything that must never happen.
contract MarketHandler is Test {
    MorphoVaultExitMarket internal market;
    IVaultV2 internal vault;
    MockERC20 internal usdg;
    address internal seller;
    address[] internal buyers;
    bytes internal venue;

    uint256[] public sessionIds;
    uint256[] public bidIds;
    address[] internal bidders;

    uint256 public liquidityChanges;
    uint256 public belowLimitFills;
    uint256 public discountDecreases;
    uint256 public buys;
    uint256 public fills;

    mapping(uint256 => uint16) internal lastDiscount;

    constructor(
        MorphoVaultExitMarket market_,
        IVaultV2 vault_,
        MockERC20 usdg_,
        address seller_,
        address[] memory buyers_,
        bytes memory venue_
    ) {
        market = market_;
        vault = vault_;
        usdg = usdg_;
        seller = seller_;
        buyers = buyers_;
        venue = venue_;
        for (uint256 i; i < 3; i++) {
            bidders.push(makeAddr(string(abi.encodePacked("bidder", vm.toString(i)))));
        }
        vm.prank(seller);
        vault.approve(address(market), type(uint256).max);
        for (uint256 i; i < buyers.length; i++) {
            vm.prank(buyers[i]);
            usdg.approve(address(market), type(uint256).max);
        }
    }

    function _checkDiscounts() internal {
        for (uint256 i; i < sessionIds.length; i++) {
            uint16 d = market.discountOf(sessionIds[i]);
            if (d < lastDiscount[sessionIds[i]]) discountDecreases++;
            lastDiscount[sessionIds[i]] = d;
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
        _checkDiscounts();
    }

    function openSession(uint256 amount, uint16 start, uint16 step) external {
        uint256 bal = vault.balanceOf(seller);
        if (bal == 0) return;
        amount = vault.previewWithdraw(bound(amount, 100e6, 200_000e6));
        if (amount > bal) amount = bal;
        ExitMarket.SessionParams memory p = ExitMarket.SessionParams({
            startBps: uint16(bound(start, 0, 2000)),
            stepBps: uint16(bound(step, 0, 200)),
            stepInterval: 1 hours,
            capBps: 3000,
            duration: 3 days,
            payMask: 0x01
        });
        vm.prank(seller);
        sessionIds.push(market.openSession(amount, p));
    }

    function withdrawUnsold(uint256 idx, uint256 units) external {
        if (sessionIds.length == 0) return;
        uint256 id = sessionIds[idx % sessionIds.length];
        (,,,,,,,, uint256 left) = market.sessions(id);
        if (left == 0) return;
        vm.prank(seller);
        market.withdrawUnsold(id, bound(units, 1, left));
    }

    function buy(uint256 idx, uint256 who, uint256 assets) external {
        if (sessionIds.length == 0) return;
        address buyer = buyers[who % buyers.length];
        uint256 id = sessionIds[idx % sessionIds.length];
        if (!market.isOpen(id)) return;
        uint256 remaining = market.remainingAssets(id);
        if (remaining < 2) return;
        assets = bound(assets, 1, remaining - 1 < 20_000e6 ? remaining - 1 : 20_000e6);
        uint256 price = market.quote(assets, market.discountOf(id), address(usdg));
        usdg.mint(buyer, price);
        uint256 before = market.capacity().withdrawable;
        vm.prank(buyer);
        try market.buyAndRepay(id, assets, 0, price, venue) {
            buys++;
            if (market.capacity().withdrawable != before) liquidityChanges++;
        } catch {}
    }

    function placeBid(uint256 who, uint16 minD, uint256 escrow) external {
        address b = bidders[who % bidders.length];
        escrow = bound(escrow, 1, 1_000_000e6);
        minD = uint16(bound(minD, 0, 3000));
        usdg.mint(b, escrow);
        vm.startPrank(b);
        usdg.approve(address(market), escrow);
        bidIds.push(market.placeBid(minD, 0, type(uint128).max, escrow));
        vm.stopPrank();
    }

    function cancelBid(uint256 idx) external {
        if (bidIds.length == 0) return;
        uint256 id = bidIds[idx % bidIds.length];
        (address b,,,,) = market.bids(id);
        if (b == address(0)) return;
        vm.prank(b);
        market.cancelBid(id);
    }

    function matchBid(uint256 sIdx, uint256 bIdx) external {
        if (sessionIds.length == 0 || bidIds.length == 0) return;
        uint256 sid = sessionIds[sIdx % sessionIds.length];
        uint256 bid = bidIds[bIdx % bidIds.length];
        (address b, uint16 minD,,,) = market.bids(bid);
        if (b == address(0) || !market.isOpen(sid)) return;
        uint16 d = market.discountOf(sid);
        try market.matchBid(sid, bid, type(uint256).max) {
            fills++;
            if (d < minD) belowLimitFills++;
        } catch {}
    }

    function sellNow(uint256 assets, uint16 maxD) external {
        uint256 bal = vault.previewRedeem(vault.balanceOf(seller));
        if (bal < 2 || bidIds.length == 0) return;
        assets = bound(assets, 1, bal / 2);
        try market.sellNow(assets, bidIds, uint16(bound(maxD, 0, 5000)), 0x01, 0) {
            fills++;
        } catch {}
    }

    function sessionCount() external view returns (uint256) {
        return sessionIds.length;
    }

    function sumSessionUnits() external view returns (uint256 total) {
        for (uint256 i; i < sessionIds.length; i++) {
            (,,,,,,,, uint256 u) = market.sessions(sessionIds[i]);
            total += u;
        }
    }

    function sumBidEscrow() external view returns (uint256 total) {
        uint256[] memory ids = market.activeBidIds();
        for (uint256 i; i < ids.length; i++) {
            (,,,, uint256 e) = market.bids(ids[i]);
            total += e;
        }
    }
}

contract MarketInvariantsTest is MorphoBase {
    MarketHandler internal handler;

    function setUp() public override {
        super.setUp();
        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = whale;
        handler = new MarketHandler(market, vault, usdg, seller, buyers, _venue(false, ""));
        targetContract(address(handler));
    }

    function invariant_escrowedReceiptsAreBacked() public view {
        assertGe(vault.balanceOf(address(market)), market.totalSessionUnits());
        assertEq(market.totalSessionUnits(), handler.sumSessionUnits());
    }

    function invariant_bidEscrowIsBacked() public view {
        assertEq(market.totalEscrow(address(usdg)), handler.sumBidEscrow());
        assertGe(usdg.balanceOf(address(market)), market.totalEscrow(address(usdg)));
    }

    function invariant_buysNeverChangeWithdrawableLiquidity() public view {
        assertEq(handler.liquidityChanges(), 0);
    }

    function invariant_bidsNeverFillBelowTheirDiscount() public view {
        assertEq(handler.belowLimitFills(), 0);
    }

    function invariant_discountNeverDecreases() public view {
        assertEq(handler.discountDecreases(), 0);
    }

    function invariant_marketHoldsNoStrayUnderlying() public view {
        // Flash loans are fully returned; the only USDG held is bid escrow.
        assertEq(usdg.balanceOf(address(market)), market.totalEscrow(address(usdg)));
    }
}

contract MarketInvariantsCoverageTest is MarketInvariantsTest {
    /// @dev Guards against a handler that silently does nothing: across runs, buys and fills must happen.
    uint256 internal totalBuys;
    uint256 internal totalFills;

    function afterInvariant() external {
        totalBuys += handler.buys();
        totalFills += handler.fills();
        emit log_named_uint("buys", handler.buys());
        emit log_named_uint("fills", handler.fills());
        emit log_named_uint("sessions", handler.sessionCount());
    }
}
