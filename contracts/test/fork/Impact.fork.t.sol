// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";

/// @dev What a purchase changes on the live Aave pool, and what it must leave alone.
contract ImpactForkTest is AaveForkBase {
    address internal bystander = makeAddr("bystander");
    address internal otherSeller = makeAddr("otherSeller");
    address internal otherBorrower = makeAddr("otherBorrower");

    function _openFor(address who, uint256 amount) internal returns (uint256 id) {
        ExitMarket.SessionParams memory p = _params();
        vm.startPrank(who);
        IERC20(A_WETH).approve(address(market), amount);
        id = market.openSession(amount, p);
        vm.stopPrank();
    }

    function test_fork_buyOnlyMovesTheTradedAmount() public {
        _supplyWeth(bystander, 25 ether);
        _supplyWeth(otherSeller, 30 ether);
        _supplyUsdc(otherBorrower, 200_000e6);
        _borrow(otherBorrower, WETH, 20 ether);
        _scene(3 ether);

        uint256 sessionId = _openSession(60 ether);
        uint256 otherSession = _openFor(otherSeller, 30 ether);
        uint256 escrow = market.quote(5 ether, 500, USDG);
        deal(USDG, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDG).approve(address(market), escrow);
        uint256 bidId = market.placeBid(500, PAY_USDG, 5 ether, escrow);
        vm.stopPrank();

        uint256 liquidity = _wethLiquidity();
        uint256 supply = IERC20(A_WETH).totalSupply();
        uint256 debtTotal = IERC20(V_WETH).totalSupply();
        uint256 bystanderBal = IERC20(A_WETH).balanceOf(bystander);
        uint256 otherDebt = _debt(otherBorrower);
        uint256 otherRemaining = market.remainingAssets(otherSession);
        uint256 hfOther = _hf(otherBorrower);
        uint256 usdgEscrow = market.totalEscrow(USDG);

        uint256 assets = 40 ether;
        uint256 price = market.quote(assets, market.discountOf(sessionId), USDG);
        deal(USDG, buyer, price);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(market), price);
        (, uint256 repaid) = market.buyAndRepay(sessionId, assets, PAY_USDG, price, "");
        vm.stopPrank();

        // The pool: withdrawable liquidity unchanged; supply and debt both fall by about the traded amount.
        assertApproxEqAbs(_wethLiquidity(), liquidity, 1, "withdrawable liquidity");
        assertApproxEqRel(supply - IERC20(A_WETH).totalSupply(), assets, 0.0001e18, "aWETH supply burned");
        assertApproxEqAbs(debtTotal - IERC20(V_WETH).totalSupply(), repaid, 200, "debt repaid");

        // Everyone else: balances only grow (interest and flash premium to suppliers), never shrink.
        assertGe(IERC20(A_WETH).balanceOf(bystander), bystanderBal, "bystander depositor");
        assertGe(_debt(otherBorrower), otherDebt, "other borrower's debt untouched");
        assertLe(_hf(otherBorrower), hfOther, "other borrower unaffected beyond interest");
        assertGe(market.remainingAssets(otherSession), otherRemaining, "other session untouched");
        assertEq(market.totalEscrow(USDG), usdgEscrow, "bid escrow untouched");
        (address stillBidder,,,, uint256 bidEscrow) = market.bids(bidId);
        assertEq(stillBidder, bidder, "bid still live");
        assertEq(bidEscrow, escrow, "bid escrow intact");
        assertGe(IERC20(A_WETH).balanceOf(address(market)) + 2, market.remainingAssets(sessionId) + otherRemaining);
    }

    function test_fork_sellNowLeavesThePoolAlone() public {
        _scene(3 ether);
        uint256 escrow = market.quote(10 ether, 400, USDG);
        deal(USDG, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDG).approve(address(market), escrow);
        uint256 bidId = market.placeBid(400, PAY_USDG, 10 ether, escrow);
        vm.stopPrank();

        uint256 liquidity = _wethLiquidity();
        uint256 supply = IERC20(A_WETH).totalSupply();
        uint256 debtTotal = IERC20(V_WETH).totalSupply();
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        IERC20(A_WETH).approve(address(market), 10 ether);
        market.sellNow(10 ether, ids, 400, 0x01, 10 ether);
        vm.stopPrank();

        // A sale into a bid only moves receipts between holders.
        assertEq(_wethLiquidity(), liquidity, "liquidity");
        assertEq(IERC20(A_WETH).totalSupply(), supply, "supply");
        assertEq(IERC20(V_WETH).totalSupply(), debtTotal, "debt");
    }
}
