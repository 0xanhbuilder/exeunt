// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {AaveForkBase} from "./AaveForkBase.t.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";

contract AaveExitMarketForkTest is AaveForkBase {
    function test_fork_capacityReadsLivePool() public view {
        ExitMarket.Capacity memory c = market.capacity();
        assertEq(c.withdrawable, _wethLiquidity());
        assertEq(c.supplied, IERC20(A_WETH).totalSupply());
        assertGt(c.utilizationBps, 9_000, "testnet WETH pool is already near-frozen");
        assertEq(c.debtorCapacity, IERC20(V_WETH).totalSupply());
    }

    function test_fork_partialLiquidity_aaveFlashLoops_keepLiquidity() public {
        _scene(5 ether);
        uint256 id = _openSession(80 ether);
        uint256 liquidityBefore = _wethLiquidity();
        uint256 debtBefore = _debt(buyer);
        uint256 sellerUsdg = IERC20(USDG).balanceOf(seller);

        uint256 assets = 50 ether;
        uint256 price = market.quote(assets, market.discountOf(id), USDG);
        deal(USDG, buyer, price);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(market), price);
        (uint256 paid, uint256 repaid) = market.buyAndRepay(id, assets, PAY_USDG, price, "");
        vm.stopPrank();

        assertEq(IERC20(USDG).balanceOf(seller) - sellerUsdg, paid, "seller paid in USDG");
        assertLt(repaid, assets, "Aave flash premium deducted");
        assertApproxEqRel(repaid, assets, 0.001e18, "premium is tiny");
        // Each repay round rounds the debt-token burn in Aave's favour by a few wei.
        assertApproxEqAbs(debtBefore - _debt(buyer), repaid, 100, "debt repaid");
        assertApproxEqAbs(_wethLiquidity(), liquidityBefore, 1, "withdrawable liquidity unchanged");
        // Aave adds the LP part of the flash premium to the liquidity index, so escrowed aWETH gains a little.
        assertGe(market.remainingAssets(id), 30 ether - 1e9, "remaining");
        assertApproxEqRel(market.remainingAssets(id), 30 ether, 0.00001e18, "remaining");
        assertGe(IERC20(A_WETH).balanceOf(address(market)) + 1, market.remainingAssets(id));
    }

    function test_fork_fullyFrozen_revertsWithoutExternalSource() public {
        _scene(0);
        uint256 id = _openSession(80 ether);
        deal(USDG, buyer, 1_000_000e6);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(market), type(uint256).max);
        vm.expectRevert(AaveExitMarket.NoFlashLiquidity.selector);
        market.buyAndRepay(id, 10 ether, PAY_USDG, type(uint256).max, "");
        vm.stopPrank();
    }

    function test_fork_fullyFrozen_externalFlash_paysSellerUsdg() public {
        IMorpho flash = _deployExternalFlash(20 ether);
        market = _deployMarket(flash);
        _scene(0);
        assertEq(_wethLiquidity(), 0, "pool frozen at 100%");
        uint256 id = _openSession(80 ether);
        vm.warp(block.timestamp + 6 hours); // 4%

        uint256 assets = 60 ether;
        uint256 price = market.quote(assets, 400, USDG);
        uint256 debtBefore = _debt(buyer);
        deal(USDG, buyer, price);
        vm.startPrank(buyer);
        IERC20(USDG).approve(address(market), price);
        (, uint256 repaid) = market.buyAndRepay(id, assets, PAY_USDG, price, "");
        vm.stopPrank();

        assertEq(repaid, assets, "external flash is free");
        assertApproxEqAbs(debtBefore - _debt(buyer), assets, 100, "debt burn rounds in Aave's favour");
        assertEq(_wethLiquidity(), 0, "still exactly 0 withdrawable");
        assertEq(IERC20(USDG).balanceOf(seller), price);
        assertEq(IERC20(WETH).balanceOf(address(flash)), 20 ether, "flash returned");
    }

    function test_fork_payWithCollateral_usdc() public {
        _scene(5 ether);
        uint256 id = _openSession(80 ether);
        uint256 assets = 40 ether;
        uint256 price = market.quote(assets, market.discountOf(id), USDC);
        uint256 hfBefore = _hf(buyer);
        uint256 usdcCollateralBefore = IERC20(A_USDC).balanceOf(buyer);

        vm.startPrank(buyer);
        IERC20(A_USDC).approve(address(market), price + market.collateralPullMargin(USDC));
        (uint256 paid,) = market.buyAndRepayWithCollateral(id, assets, PAY_USDC, price, "");
        vm.stopPrank();
        assertEq(IERC20(A_USDC).balanceOf(address(market)), 0, "rounding margin refunded");

        assertEq(IERC20(USDC).balanceOf(seller), paid, "seller receives USDC");
        assertApproxEqAbs(usdcCollateralBefore - IERC20(A_USDC).balanceOf(buyer), paid, 2);
        assertGt(_hf(buyer), hfBefore, "health factor improves");
        assertEq(IERC20(USDC).balanceOf(buyer), 0, "no cash needed");
    }

    function test_fork_payWithCollateral_requiresApproval() public {
        _scene(5 ether);
        uint256 id = _openSession(80 ether);
        vm.prank(buyer);
        vm.expectRevert();
        market.buyAndRepayWithCollateral(id, 10 ether, PAY_USDC, type(uint256).max, "");
    }

    function test_fork_sellNow_intoUsdgBid_andRedeemLater() public {
        _scene(0);
        uint256 escrow = market.quote(10 ether, 500, USDG);
        deal(USDG, bidder, escrow);
        vm.startPrank(bidder);
        IERC20(USDG).approve(address(market), escrow);
        uint256 bidId = market.placeBid(500, PAY_USDG, 10 ether, escrow);
        vm.stopPrank();

        uint256[] memory ids = new uint256[](1);
        ids[0] = bidId;
        vm.startPrank(seller);
        IERC20(A_WETH).approve(address(market), type(uint256).max);
        (uint256 filled,) = market.sellNow(10 ether, ids, 500, 0x01, 10 ether);
        vm.stopPrank();
        assertEq(filled, 10 ether);
        assertApproxEqAbs(IERC20(USDG).balanceOf(seller), escrow, 1);
        assertApproxEqAbs(IERC20(A_WETH).balanceOf(bidder), 10 ether, 5);

        // Liquidity returns: the whale repays; the bidder recovers WETH at face value.
        deal(WETH, whale, 50 ether);
        vm.startPrank(whale);
        IERC20(WETH).approve(address(POOL), 50 ether);
        POOL.repay(WETH, 50 ether, 2, whale);
        vm.stopPrank();
        vm.startPrank(bidder);
        IERC20(A_WETH).approve(address(market), type(uint256).max);
        uint256 got = market.redeemReceipt(9.9 ether, bidder);
        vm.stopPrank();
        assertEq(IERC20(WETH).balanceOf(bidder), got);
        assertApproxEqAbs(got, 9.9 ether, 10, "face value within Aave rounding");
    }

    function test_fork_withdrawUnsold_returnsATokens() public {
        _scene(5 ether);
        uint256 before = IERC20(A_WETH).balanceOf(seller);
        uint256 id = _openSession(50 ether);
        vm.warp(block.timestamp + 1 days);
        vm.prank(seller);
        uint256 back = market.withdrawUnsold(id, type(uint256).max);
        assertGe(back, 50 ether, "interest kept accruing while escrowed");
        assertGe(IERC20(A_WETH).balanceOf(seller), before, "all receipts returned");
        assertEq(market.totalSessionUnits(), 0);
    }

    function test_fork_flashCallbacks_rejectSpoofedCalls() public {
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.executeOperation(WETH, 1, 0, address(market), "");
        vm.prank(address(POOL));
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.executeOperation(WETH, 1, 0, address(this), "");
        vm.expectRevert(AaveExitMarket.UnexpectedCallback.selector);
        market.onMorphoFlashLoan(1, "");
    }

    function test_fork_constructor_rejectsMismatchedCollateralAToken() public {
        address[] memory tokens = new address[](2);
        tokens[0] = USDC;
        tokens[1] = WETH;
        address[] memory aTokens = new address[](2);
        aTokens[0] = A_WETH; // aWETH is not USDC's aToken
        vm.expectRevert(ExitMarket.BadParams.selector);
        new AaveExitMarket(POOL, A_WETH, V_WETH, prices, tokens, aTokens, IMorpho(address(0)));
    }

    function test_fork_flashCapacity_andReceiptValue() public view {
        (uint256 aaveChunk, uint256 extChunk) = market.flashCapacity();
        assertGt(aaveChunk, 0);
        assertEq(extChunk, 0);
        assertEq(market.receiptValue(1 ether), 1 ether);
    }
}
