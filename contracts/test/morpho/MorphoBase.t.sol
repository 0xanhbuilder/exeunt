// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams, Authorization, Signature} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoStack} from "../../script/lib/MorphoStack.sol";
import {MorphoVaultExitMarket} from "../../src/venues/morpho/MorphoVaultExitMarket.sol";
import {ExitMarket} from "../../src/market/ExitMarket.sol";
import {PriceRouter} from "../../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../../src/shared/oracle/FixedPriceFeed.sol";
import {MockERC20} from "../utils/MockERC20.sol";
import {MockMorphoOracle} from "../utils/MockMorphoOracle.sol";

/// @dev Local Robinhood-Earn-like environment: a USDG Vault V2 fully lent out in one Morpho market (frozen),
///      plus a separate liquid market that gives Morpho flash-loan liquidity.
abstract contract MorphoBase is Test, MorphoStack {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;

    bytes32 internal constant AUTHORIZATION_TYPEHASH = keccak256(
        "Authorization(address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline)"
    );

    uint256 internal constant USD = 1e6;
    uint256 internal constant ORACLE_PRICE = 1e24; // 1 sim-USDe (18 dec) = 1 USDG (6 dec), scaled 1e36

    MockERC20 internal usdg;
    MockERC20 internal usde;
    MockMorphoOracle internal oracle;
    Stack internal s;
    IMorpho internal morpho;
    IVaultV2 internal vault;
    PriceRouter internal prices;
    MorphoVaultExitMarket internal market;

    address internal seller = makeAddr("seller");
    address internal whale = makeAddr("whale");
    address internal flashLender = makeAddr("flashLender");
    address internal bidder = makeAddr("bidder");
    address internal keeper = makeAddr("keeper");
    uint256 internal buyerKey = 0xB0B;
    address internal buyer = vm.addr(buyerKey);

    uint8 internal constant PAY_USDG = 0;
    uint8 internal constant PAY_USDE = 1;

    function setUp() public virtual {
        vm.warp(1_780_000_000);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        usde = new MockERC20("Simulated USDe", "sUSDe-sim", 18);
        oracle = new MockMorphoOracle(ORACLE_PRICE);
        s = _buildMorphoStack(address(this), address(usdg), address(usde), address(oracle), "Earn USDG", "eUSDG");
        morpho = s.morpho;
        vault = s.vault;

        address[] memory tokens = new address[](2);
        tokens[0] = address(usdg);
        tokens[1] = address(usde);
        address[] memory feeds = new address[](2);
        feeds[0] = address(new FixedPriceFeed(1e8, 8));
        feeds[1] = address(new FixedPriceFeed(1e8, 8));
        prices = new PriceRouter(tokens, feeds, 1 days);
        market = new MorphoVaultExitMarket(morpho, vault, s.adapter, prices, tokens);

        // Depositors: the seller holds 1,000,000 USDG of vault shares, allocated to the earn market.
        _depositToVault(seller, 1_000_000 * USD);
        // Separate liquid market: Morpho holds idle USDG that can be flash-borrowed.
        _supplyFlashMarket(200_000 * USD);
        // Borrowers drain the earn market to 100% utilization.
        _borrow(buyer, 400_000 ether, 300_000 * USD);
        _borrow(whale, 1_000_000 ether, 700_000 * USD);
    }

    /* ----------------------------- helpers ----------------------------- */

    function _depositToVault(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _supplyFlashMarket(uint256 amount) internal {
        usdg.mint(flashLender, amount);
        vm.startPrank(flashLender);
        usdg.approve(address(morpho), amount);
        morpho.supply(s.flashMarket, amount, 0, flashLender, "");
        vm.stopPrank();
    }

    function _withdrawFlashMarket(uint256 amount) internal {
        vm.prank(flashLender);
        morpho.withdraw(s.flashMarket, amount, 0, flashLender, flashLender);
    }

    function _borrow(address who, uint256 collateral, uint256 amount) internal {
        usde.mint(who, collateral);
        vm.startPrank(who);
        usde.approve(address(morpho), collateral);
        morpho.supplyCollateral(s.earnMarket, collateral, who, "");
        morpho.borrow(s.earnMarket, amount, 0, who, who);
        vm.stopPrank();
    }

    function _debt(address who) internal view returns (uint256) {
        return morpho.expectedBorrowAssets(s.earnMarket, who);
    }

    function _withdrawable() internal view returns (uint256) {
        return market.capacity().withdrawable;
    }

    function _defaultParams() internal pure returns (ExitMarket.SessionParams memory p) {
        p = ExitMarket.SessionParams({
            startBps: 100, stepBps: 50, stepInterval: 1 hours, capBps: 1000, duration: 7 days, payMask: 0x03
        });
    }

    /// @dev Seller escrows shares worth `assets` USDG and opens a session.
    function _openSession(uint256 assets) internal returns (uint256 id) {
        return _openSession(assets, _defaultParams());
    }

    function _openSession(uint256 assets, ExitMarket.SessionParams memory p) internal returns (uint256 id) {
        uint256 shares = vault.previewWithdraw(assets);
        vm.startPrank(seller);
        vault.approve(address(market), shares);
        id = market.openSession(shares, p);
        vm.stopPrank();
    }

    function _venue(bool force, bytes memory auth) internal view returns (bytes memory) {
        return abi.encode(s.earnMarket, force, auth);
    }

    function _signAuth(uint256 key, address authorizer, bool isAuthorized, uint256 nonce)
        internal
        view
        returns (Authorization memory a, Signature memory sig)
    {
        a = Authorization({
            authorizer: authorizer,
            authorized: address(market),
            isAuthorized: isAuthorized,
            nonce: nonce,
            deadline: block.timestamp + 1 hours
        });
        bytes32 digest = keccak256(
            bytes.concat("\x19\x01", morpho.DOMAIN_SEPARATOR(), keccak256(abi.encode(AUTHORIZATION_TYPEHASH, a)))
        );
        (sig.v, sig.r, sig.s) = vm.sign(key, digest);
    }

    function _authBundle(uint256 key, address who) internal view returns (bytes memory) {
        uint256 n = morpho.nonce(who);
        (Authorization memory g, Signature memory gs) = _signAuth(key, who, true, n);
        (Authorization memory r, Signature memory rs) = _signAuth(key, who, false, n + 1);
        return abi.encode(g, gs, r, rs);
    }
}
