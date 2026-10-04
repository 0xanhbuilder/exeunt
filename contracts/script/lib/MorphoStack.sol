// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";

/// @notice Deploys a Morpho Blue + Vault V2 stack shaped like a Robinhood Earn USDG vault.
/// @dev Shared by the Robinhood Testnet deployment and the local test suite. The caller (test contract or
///      broadcasting deployer) becomes Morpho owner, vault owner, curator and allocator; all timelocks are zero.
abstract contract MorphoStack is CommonBase {
    uint256 internal constant EARN_LLTV = 0.86e18;
    uint256 internal constant FLASH_LLTV = 0.77e18;
    uint256 internal constant MAX_RATE = 200e16 / uint256(365 days);

    struct Stack {
        IMorpho morpho;
        address irm;
        IVaultV2 vault;
        address adapter;
        /// @dev Market the vault supplies to; borrowers here are the exit buyers.
        MarketParams earnMarket;
        /// @dev Separate market whose idle loan tokens give Morpho free flash-loan liquidity.
        MarketParams flashMarket;
    }

    function _create(string memory artifact, bytes memory args) internal returns (address deployed) {
        bytes memory code = abi.encodePacked(vm.getCode(artifact), args);
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), artifact);
    }

    function _buildMorphoStack(
        address admin,
        address loanToken,
        address collateralToken,
        address oracle,
        string memory vaultName,
        string memory vaultSymbol
    ) internal returns (Stack memory s) {
        s.morpho = IMorpho(_create("out/Morpho.sol/Morpho.json", abi.encode(admin)));
        s.irm = _create("out/AdaptiveCurveIrm.sol/AdaptiveCurveIrm.json", abi.encode(address(s.morpho)));
        s.morpho.enableIrm(s.irm);
        s.morpho.enableLltv(EARN_LLTV);
        s.morpho.enableLltv(FLASH_LLTV);
        s.earnMarket = MarketParams(loanToken, collateralToken, oracle, s.irm, EARN_LLTV);
        s.flashMarket = MarketParams(loanToken, collateralToken, oracle, s.irm, FLASH_LLTV);
        s.morpho.createMarket(s.earnMarket);
        s.morpho.createMarket(s.flashMarket);

        VaultV2 v = new VaultV2(admin, loanToken);
        s.vault = IVaultV2(address(v));
        s.vault.setName(vaultName);
        s.vault.setSymbol(vaultSymbol);
        s.vault.setCurator(admin);
        _timelocked(s.vault, abi.encodeCall(IVaultV2.setIsAllocator, (admin, true)));

        s.adapter = address(new MorphoMarketV1AdapterV2(address(v), address(s.morpho), s.irm));
        _timelocked(s.vault, abi.encodeCall(IVaultV2.addAdapter, (s.adapter)));
        _cap(s.vault, abi.encode("this", s.adapter));
        _cap(s.vault, abi.encode("collateralToken", collateralToken));
        _cap(s.vault, abi.encode("this/marketParams", s.adapter, s.earnMarket));
        s.vault.setLiquidityAdapterAndData(s.adapter, abi.encode(s.earnMarket));
        s.vault.setMaxRate(MAX_RATE);
    }

    function _timelocked(IVaultV2 vault, bytes memory call) internal {
        vault.submit(call);
        (bool ok, bytes memory ret) = address(vault).call(call);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _cap(IVaultV2 vault, bytes memory idData) internal {
        _timelocked(vault, abi.encodeCall(IVaultV2.increaseAbsoluteCap, (idData, type(uint128).max)));
        _timelocked(vault, abi.encodeCall(IVaultV2.increaseRelativeCap, (idData, 1e18)));
    }
}
