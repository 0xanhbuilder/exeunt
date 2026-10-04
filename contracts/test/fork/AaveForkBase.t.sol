// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {AaveExitMarket} from "../../src/venues/aave/AaveExitMarket.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {IAavePool} from "../../src/shared/interfaces/IAaveV3.sol";

/// @dev Fork of Arbitrum Sepolia with the live Aave V3 testnet market. Our actors supply and borrow on the real
///      pool; a whale then borrows the remaining WETH so the pool is frozen (utilization ~100%).
abstract contract AaveForkBase is Test {
    IAavePool internal constant POOL = IAavePool(0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff);
    address internal constant WETH = 0x1dF462e2712496373A347f8ad10802a5E95f053D;
    address internal constant A_WETH = 0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60;
    address internal constant V_WETH = 0x372eB464296D8D78acaa462b41eaaf2D3663dAD3;
    address internal constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address internal constant A_USDC = 0x460b97BD498E1157530AEb3086301d5225b91216;
    address internal constant USDG = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892;
    address internal constant ETH_USD_FEED = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165;
    address internal constant USDC_USD_FEED = 0x0153002d20B96532C639313c2d54c3dA09109309;
    uint256 internal constant DEFAULT_FORK_BLOCK = 315_599_168;

    uint8 internal constant PAY_USDG = 0;
    uint8 internal constant PAY_USDC = 1;
    uint8 internal constant PAY_WETH = 2;

    PriceRouter internal prices;
    AaveExitMarket internal market;

    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal whale = makeAddr("whale");
    address internal bidder = makeAddr("bidder");

    bool internal forked;

    function setUp() public virtual {
        string memory rpc = vm.envOr("ARB_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, vm.envOr("ARB_SEPOLIA_FORK_BLOCK", DEFAULT_FORK_BLOCK));
        forked = true;

        address[] memory tokens = new address[](3);
        tokens[0] = USDG;
        tokens[1] = USDC;
        tokens[2] = WETH;
        address[] memory feeds = new address[](3);
        feeds[0] = address(new FixedPriceFeed(1e8, 8));
        feeds[1] = USDC_USD_FEED;
        feeds[2] = ETH_USD_FEED;
        prices = new PriceRouter(tokens, feeds, 2 days);
        market = _deployMarket(IMorpho(address(0)));
    }

    function _deployMarket(IMorpho externalFlash) internal returns (AaveExitMarket m) {
        address[] memory tokens = new address[](3);
        tokens[0] = USDG;
        tokens[1] = USDC;
        tokens[2] = WETH;
        address[] memory aTokens = new address[](3);
        aTokens[1] = A_USDC;
        m = new AaveExitMarket(POOL, A_WETH, V_WETH, prices, tokens, aTokens, externalFlash);
    }

    /* ----------------------------- actors ------------------------------ */

    function _supplyWeth(address who, uint256 amount) internal {
        deal(WETH, who, amount);
        vm.startPrank(who);
        IERC20(WETH).approve(address(POOL), amount);
        POOL.supply(WETH, amount, who, 0);
        vm.stopPrank();
    }

    function _supplyUsdc(address who, uint256 amount) internal {
        deal(USDC, who, amount);
        vm.startPrank(who);
        IERC20(USDC).approve(address(POOL), amount);
        POOL.supply(USDC, amount, who, 0);
        vm.stopPrank();
    }

    function _borrow(address who, address asset, uint256 amount) internal {
        vm.prank(who);
        POOL.borrow(asset, amount, 2, 0, who);
    }

    function _wethLiquidity() internal view returns (uint256) {
        return IERC20(WETH).balanceOf(A_WETH);
    }

    /// @dev Whale borrows WETH until only `leave` remains withdrawable.
    function _freeze(uint256 leave) internal {
        uint256 liquidity = _wethLiquidity();
        if (liquidity <= leave) return;
        _supplyUsdc(whale, 2_000_000e6);
        _borrow(whale, WETH, liquidity - leave);
    }

    /// @dev Standard scene: seller holds 100 aWETH, buyer owes 60 WETH against USDC, pool frozen to `leave`.
    function _scene(uint256 leave) internal {
        _supplyWeth(seller, 100 ether);
        _supplyUsdc(buyer, 1_000_000e6);
        _borrow(buyer, WETH, 60 ether);
        _freeze(leave);
    }

    function _params() internal pure returns (ExitMarket.SessionParams memory) {
        return ExitMarket.SessionParams({
            startBps: 100, stepBps: 50, stepInterval: 1 hours, capBps: 1500, duration: 7 days, payMask: 0x07
        });
    }

    function _openSession(uint256 amount) internal returns (uint256 id) {
        ExitMarket.SessionParams memory p = _params();
        vm.startPrank(seller);
        IERC20(A_WETH).approve(address(market), amount);
        id = market.openSession(amount, p);
        vm.stopPrank();
    }

    function _debt(address who) internal view returns (uint256) {
        return IERC20(V_WETH).balanceOf(who);
    }

    function _hf(address who) internal view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(who);
    }

    /// @dev Deploys a Morpho Blue singleton on the fork and parks idle WETH in it, standing in for an external
    ///      flash source (on Arbitrum One the real Morpho singleton holds WETH).
    function _deployExternalFlash(uint256 wethAmount) internal returns (IMorpho morpho) {
        bytes memory code = abi.encodePacked(vm.getCode("out/Morpho.sol/Morpho.json"), abi.encode(address(this)));
        address m;
        assembly {
            m := create(0, add(code, 0x20), mload(code))
        }
        morpho = IMorpho(m);
        morpho.enableIrm(address(0));
        morpho.enableLltv(0);
        MarketParams memory mp = MarketParams(WETH, address(0), address(0), address(0), 0);
        morpho.createMarket(mp);
        deal(WETH, address(this), wethAmount);
        IERC20(WETH).approve(address(morpho), wethAmount);
        morpho.supply(mp, wethAmount, 0, address(this), "");
    }
}
