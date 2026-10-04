// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {ExeuntVault} from "../../src/vault/ExeuntVault.sol";
import {AaveCollateralRoute} from "../../src/route/AaveCollateralRoute.sol";

contract RouteAndVaultForkTest is AaveForkBase {
    AaveCollateralRoute internal route;
    ExeuntVault internal ev;
    address internal borrower = makeAddr("borrower");
    address internal depositor = makeAddr("depositor");

    function setUp() public override {
        super.setUp();
        route = new AaveCollateralRoute(POOL);
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = 300;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = 2_000;
        ev = new ExeuntVault("Exeunt Vault WETH", "xWETH", IERC20(WETH), markets, minD, maxShare);
    }

    /// @dev Borrower posted WETH as collateral and borrowed USDC; then the WETH pool froze.
    function _borrowerScene() internal {
        _supplyWeth(borrower, 50 ether);
        _borrow(borrower, USDC, 60_000e6);
        _supplyWeth(seller, 100 ether);
        _freeze(0);
    }

    function _usdcBid(uint256 escrow, uint16 minD) internal returns (uint256 bidId) {
        deal(USDC, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDC).approve(address(market), escrow);
        bidId = market.placeBid(minD, PAY_USDC, type(uint128).max, escrow);
        vm.stopPrank();
    }

    function test_fork_route_repayWithFrozenCollateral() public {
        _borrowerScene();
        uint256 bidId = _usdcBid(100_000e6, 500);
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        uint256 hfBefore = _hf(borrower);
        uint256 collateralBefore = IERC20(A_WETH).balanceOf(borrower);

        vm.startPrank(borrower);
        IERC20(A_WETH).approve(address(route), 12 ether);
        uint256 sold = route.repayWithFrozenCollateral(market, 12 ether, ids, 500, PAY_USDC, 30_000e6);
        vm.stopPrank();

        assertGt(sold, 11.99 ether);
        assertApproxEqAbs(collateralBefore - IERC20(A_WETH).balanceOf(borrower), sold, 10);
        assertGt(IERC20(USDC).balanceOf(borrower), 60_000e6, "surplus proceeds returned");
        assertGt(_hf(borrower), hfBefore, "health improves");
        assertEq(_wethLiquidity(), 0, "frozen pool untouched");
        assertEq(IERC20(A_WETH).balanceOf(address(route)), 0, "route keeps nothing");
        assertEq(IERC20(USDC).balanceOf(address(route)), 0);
    }

    function test_fork_route_repay_revertsWhenProceedsTooLow() public {
        _borrowerScene();
        uint256 bidId = _usdcBid(100_000e6, 500);
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(borrower);
        IERC20(A_WETH).approve(address(route), 1 ether);
        vm.expectRevert();
        route.repayWithFrozenCollateral(market, 1 ether, ids, 500, PAY_USDC, 30_000e6);
        vm.stopPrank();
    }

    function test_fork_route_swapFrozenCollateral_toUsdc() public {
        _borrowerScene();
        uint256 bidId = _usdcBid(100_000e6, 500);
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        uint256 usdcCollBefore = IERC20(A_USDC).balanceOf(borrower);
        vm.startPrank(borrower);
        IERC20(A_WETH).approve(address(route), 10 ether);
        (uint256 sold, uint256 supplied) = route.swapFrozenCollateral(market, 10 ether, ids, 500, PAY_USDC, 1);
        vm.stopPrank();
        assertGt(sold, 9.99 ether);
        assertApproxEqAbs(IERC20(A_USDC).balanceOf(borrower) - usdcCollBefore, supplied, 2, "new collateral");
        assertGe(_hf(borrower), 1e18);
    }

    function test_fork_route_onlyActsForCaller() public {
        _borrowerScene();
        uint256 bidId = _usdcBid(100_000e6, 500);
        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.prank(borrower);
        IERC20(A_WETH).approve(address(route), 10 ether);
        // Someone else cannot spend the borrower's approval: the route pulls from msg.sender only.
        vm.prank(bidder);
        vm.expectRevert();
        route.swapFrozenCollateral(market, 10 ether, ids, 500, PAY_USDC, 1);
    }

    /* ------------------------- Exeunt Vault (WETH) ------------------------- */

    function test_fork_vault_buysFrozenAWeth_thenRecovers() public {
        _scene(0);
        deal(WETH, depositor, 100 ether);
        vm.startPrank(depositor);
        IERC20(WETH).approve(address(ev), 100 ether);
        uint256 shares = ev.deposit(100 ether, depositor);
        vm.stopPrank();
        uint256 bidId = ev.bidOf(0);

        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        IERC20(A_WETH).approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(30 ether, ids, 300, 0x04, 1);
        vm.stopPrank();
        assertEq(filled, 20 ether, "capped at 20% of vault capital");
        assertEq(IERC20(WETH).balanceOf(seller), 19.4 ether, "seller paid in WETH at 3%");

        vm.expectRevert();
        ev.recover(0, type(uint256).max);

        deal(WETH, whale, 100 ether);
        vm.startPrank(whale);
        IERC20(WETH).approve(address(POOL), 100 ether);
        POOL.repay(WETH, 100 ether, 2, whale);
        vm.stopPrank();
        ev.recover(0, type(uint256).max);
        assertLe(ev.heldAssets(0), 10);
        assertGe(ev.totalAssets(), 100.6 ether - 10, "discount captured");

        vm.prank(depositor);
        (uint256 out,) = ev.redeem(shares, depositor, depositor);
        assertGe(out, 100.6 ether - 1e6);
    }
}
