// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoStack} from "./lib/MorphoStack.sol";
import {ExitMarket} from "../src/market/ExitMarket.sol";
import {AaveExitMarket} from "../src/venues/aave/AaveExitMarket.sol";
import {MorphoVaultExitMarket} from "../src/venues/morpho/MorphoVaultExitMarket.sol";
import {ExeuntVault} from "../src/vault/ExeuntVault.sol";
import {AaveCollateralRoute} from "../src/route/AaveCollateralRoute.sol";
import {PriceRouter} from "../src/shared/oracle/PriceRouter.sol";
import {FixedPriceFeed} from "../src/shared/oracle/FixedPriceFeed.sol";
import {ChainedPriceFeed} from "../src/shared/oracle/ChainedPriceFeed.sol";
import {IPriceFeed} from "../src/shared/interfaces/IPriceFeed.sol";
import {IAavePool} from "../src/shared/interfaces/IAaveV3.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {FixedMorphoOracle} from "../src/testnet/FixedMorphoOracle.sol";

/// @notice Deploys Exeunt to one network. DEPLOY_NETWORK selects:
///   arbitrum-sepolia   live Aave V3 testnet market (aWETH)
///   kelp-replay        Arbitrum One fork at the April 2026 WETH freeze (aWETH, Morpho as external flash)
///   robinhood-testnet  self-deployed Morpho + Vault V2 shaped like Robinhood Earn (USDG vault shares)
///   earn-bank-run      Robinhood Chain fork against the live Steakhouse USDG vault
/// Writes <DEPLOY_OUT_DIR>/<network>.json (default ./deployments/; local fork runs use ./deployments/local/).
contract Deploy is Script, MorphoStack {
    uint16 internal constant VAULT_MIN_DISCOUNT_BPS = 300;
    uint16 internal constant VAULT_MAX_SHARE_BPS = 2_000;
    uint256 internal constant PRICE_MAX_AGE = 2 days;

    struct AaveConfig {
        address pool;
        address aToken;
        address debtToken;
        address[] payTokens;
        address[] payATokens;
        address[] feeds;
        address externalFlash;
    }

    string internal network;
    address internal deployer;
    string internal out = "deployment";

    function run() external {
        network = vm.envString("DEPLOY_NETWORK");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        deployer = vm.addr(pk);
        vm.serializeString(out, "network", network);
        vm.serializeUint(out, "chainId", block.chainid);
        vm.serializeUint(out, "deployBlock", block.number);
        vm.serializeAddress(out, "deployer", deployer);

        vm.startBroadcast(pk);
        bytes32 n = keccak256(bytes(network));
        if (n == keccak256("arbitrum-sepolia")) {
            _deployAave(_arbitrumSepolia());
        } else if (n == keccak256("kelp-replay")) {
            _deployAave(_arbitrumOne());
        } else if (n == keccak256("robinhood-testnet")) {
            _deployRobinhoodTestnet();
        } else if (n == keccak256("earn-bank-run")) {
            _deployEarnFork();
        } else {
            revert("unknown DEPLOY_NETWORK");
        }
        vm.stopBroadcast();

        string memory json = vm.serializeString(out, "venue", _isAave(n) ? "aave" : "morpho");
        string memory dir = vm.envOr("DEPLOY_OUT_DIR", string("./deployments/"));
        vm.writeJson(json, string.concat(dir, network, ".json"));
    }

    function _isAave(bytes32 n) internal pure returns (bool) {
        return n == keccak256("arbitrum-sepolia") || n == keccak256("kelp-replay");
    }

    /* ------------------------------ Aave ------------------------------ */

    function _arbitrumSepolia() internal returns (AaveConfig memory c) {
        c.pool = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
        c.aToken = 0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60; // aWETH
        c.debtToken = 0x372eB464296D8D78acaa462b41eaaf2D3663dAD3;
        c.payTokens = new address[](3);
        c.payTokens[0] = 0xFFC95faa3d63Cde504a05B567C600B78C0b41892; // USDG (Paxos testnet)
        c.payTokens[1] = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d; // USDC
        c.payTokens[2] = 0x1dF462e2712496373A347f8ad10802a5E95f053D; // WETH
        c.payATokens = new address[](3);
        c.payATokens[1] = 0x460b97BD498E1157530AEb3086301d5225b91216; // aUSDC
        c.feeds = new address[](3);
        c.feeds[0] = address(new FixedPriceFeed(1e8, 8)); // no USDG feed on testnet: $1
        c.feeds[1] = 0x0153002d20B96532C639313c2d54c3dA09109309; // Chainlink USDC/USD
        c.feeds[2] = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165; // Chainlink ETH/USD
        c.externalFlash = vm.envOr("EXTERNAL_FLASH", address(0));
    }

    function _arbitrumOne() internal returns (AaveConfig memory c) {
        c.pool = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        c.aToken = 0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8; // aArbWETH
        c.debtToken = 0x0c84331e39d6658Cd6e6b9ba04736cC4c4734351;
        c.payTokens = new address[](4);
        c.payTokens[0] = 0x004B506865409877C9fA29bfb1ebA929984B9bbC; // USDG
        c.payTokens[1] = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // USDC
        c.payTokens[2] = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // WETH
        c.payTokens[3] = 0x5979D7b546E38E414F7E9822514be443A4800529; // wstETH
        c.payATokens = new address[](4);
        c.payATokens[1] = 0x724dc807b04555b71ed48a6896b6F41593b8C637; // aArbUSDCn
        c.payATokens[3] = 0x513c7E3a9c69cA3e22550eF58AC1C0088e918FFf; // aArbwstETH
        address ethUsd = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612;
        c.feeds = new address[](4);
        c.feeds[0] = address(new FixedPriceFeed(1e8, 8));
        c.feeds[1] = 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3; // USDC/USD
        c.feeds[2] = ethUsd;
        c.feeds[3] = address(
            new ChainedPriceFeed(IPriceFeed(0xb523AE262D20A936BC152e6023996e46FDC2A95D), IPriceFeed(ethUsd))
        ); // wstETH/ETH x ETH/USD
        c.externalFlash = 0x6c247b1F6182318877311737BaC0844bAa518F5e; // Morpho Blue singleton
    }

    function _deployAave(AaveConfig memory c) internal {
        PriceRouter prices = new PriceRouter(c.payTokens, c.feeds, PRICE_MAX_AGE);
        AaveExitMarket market = new AaveExitMarket(
            IAavePool(c.pool), c.aToken, c.debtToken, prices, c.payTokens, c.payATokens, IMorpho(c.externalFlash)
        );
        AaveCollateralRoute route = new AaveCollateralRoute(IAavePool(c.pool));
        ExeuntVault vault = _deployVault(market, "Exeunt Vault WETH", "xWETH");

        vm.serializeAddress(out, "priceRouter", address(prices));
        vm.serializeAddress(out, "market", address(market));
        vm.serializeAddress(out, "receipt", c.aToken);
        vm.serializeAddress(out, "underlying", market.underlying());
        vm.serializeAddress(out, "debtToken", c.debtToken);
        vm.serializeAddress(out, "aavePool", c.pool);
        vm.serializeAddress(out, "externalFlash", c.externalFlash);
        vm.serializeAddress(out, "payTokens", c.payTokens);
        vm.serializeAddress(out, "payATokens", c.payATokens);
        vm.serializeAddress(out, "collateralRoute", address(route));
        vm.serializeAddress(out, "exeuntVault", address(vault));
    }

    function _deployVault(ExitMarket market, string memory name, string memory symbol)
        internal
        returns (ExeuntVault)
    {
        ExitMarket[] memory markets = new ExitMarket[](1);
        markets[0] = market;
        uint16[] memory minD = new uint16[](1);
        minD[0] = VAULT_MIN_DISCOUNT_BPS;
        uint16[] memory maxShare = new uint16[](1);
        maxShare[0] = VAULT_MAX_SHARE_BPS;
        return new ExeuntVault(name, symbol, IERC20(market.underlying()), markets, minD, maxShare);
    }

    /* ----------------------------- Morpho ----------------------------- */

    function _deployRobinhoodTestnet() internal {
        address usdg = vm.envOr("USDG_ADDRESS", 0x7E955252E15c84f5768B83c41a71F9eba181802F); // Paxos testnet USDG
        TestToken usde = new TestToken("Simulated USDe", "sUSDe-sim", 18, 1_000_000 ether);
        // 1 sim-USDe (18 decimals) = 1 USDG (6 decimals), scaled by 1e36.
        FixedMorphoOracle oracle = new FixedMorphoOracle(1e24);
        Stack memory s = _buildMorphoStack(deployer, usdg, address(usde), address(oracle), "Earn USDG (sim)", "eUSDG");
        _deployMorphoMarket(s.morpho, s.vault, s.adapter, usdg, address(usde));

        vm.serializeAddress(out, "morpho", address(s.morpho));
        vm.serializeAddress(out, "irm", s.irm);
        vm.serializeAddress(out, "collateral", address(usde));
        vm.serializeAddress(out, "morphoOracle", address(oracle));
        vm.serializeBytes32(out, "earnMarketId", keccak256(abi.encode(s.earnMarket)));
        vm.serializeBytes32(out, "flashMarketId", keccak256(abi.encode(s.flashMarket)));
    }

    function _deployEarnFork() internal {
        IMorpho morpho = IMorpho(0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010);
        IVaultV2 steakhouse = IVaultV2(0xBeEff033F34C046626B8D0A041844C5d1A5409dd);
        address adapter = 0x44ABc1d6cCFF2696d98890B92E2157AF242179c2;
        address usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
        address usde = 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34;
        _deployMorphoMarket(morpho, steakhouse, adapter, usdg, usde);
        vm.serializeAddress(out, "morpho", address(morpho));
        vm.serializeAddress(out, "collateral", usde);
    }

    function _deployMorphoMarket(IMorpho morpho, IVaultV2 earn, address adapter, address usdg, address collateral)
        internal
    {
        address[] memory tokens = new address[](2);
        tokens[0] = usdg;
        tokens[1] = collateral;
        address[] memory feeds = new address[](2);
        // No Chainlink on Robinhood Chain: both stable assets priced at $1.
        feeds[0] = address(new FixedPriceFeed(1e8, 8));
        feeds[1] = address(new FixedPriceFeed(1e8, 8));
        PriceRouter prices = new PriceRouter(tokens, feeds, PRICE_MAX_AGE);
        MorphoVaultExitMarket market = new MorphoVaultExitMarket(morpho, earn, adapter, prices, tokens);
        ExeuntVault vault = _deployVault(market, "Exeunt Vault USDG", "xUSDG");

        vm.serializeAddress(out, "priceRouter", address(prices));
        vm.serializeAddress(out, "market", address(market));
        vm.serializeAddress(out, "receipt", address(earn));
        vm.serializeAddress(out, "underlying", usdg);
        vm.serializeAddress(out, "earnVault", address(earn));
        vm.serializeAddress(out, "adapter", adapter);
        vm.serializeAddress(out, "payTokens", tokens);
        vm.serializeAddress(out, "exeuntVault", address(vault));
    }
}
