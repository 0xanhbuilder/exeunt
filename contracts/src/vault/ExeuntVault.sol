// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ExitMarket} from "../market/ExitMarket.sol";

/// @title ExeuntVault
/// @notice Pooled buyer of last resort. Depositors' idle capital stays outside the protected pool and is
///         escrowed as limit bids on exit markets of the same denomination. Bought receipts are held until
///         the pool is liquid again; anyone can trigger their redemption. Depositors exit at any time,
///         receiving idle capital in the vault asset and their share of held receipts in kind.
/// @dev Rules are fixed at deployment: per market, a minimum discount and a maximum share of vault capital.
///      There is no owner, no fee and no admin function.
contract ExeuntVault is ERC20, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint8 internal constant DECIMALS_OFFSET = 3;
    uint256 internal constant VIRTUAL_SHARES = 10 ** DECIMALS_OFFSET;
    uint256 public constant MAX_STRATEGIES = 8;

    struct Strategy {
        ExitMarket market;
        IERC20 receipt;
        uint16 minDiscountBps;
        uint16 maxShareBps;
        uint8 payIdx;
    }

    IERC20 public immutable asset;
    uint8 internal immutable assetDecimals;
    Strategy[] internal strategies_;
    /// @notice Active bid of the vault on each strategy's market (0 when none).
    uint256[] public bidOf;

    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);
    event Redeem(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 shares,
        uint256 assets,
        uint256[] receipts
    );
    event Recovered(uint256 indexed strategy, address indexed caller, uint256 assets);
    event BidsRefreshed(uint256 totalAssets, uint256 idle);

    error BadParams();
    error ZeroShares();
    error ZeroAmount();

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 asset_,
        ExitMarket[] memory markets,
        uint16[] memory minDiscountBps,
        uint16[] memory maxShareBps
    ) ERC20(name_, symbol_) {
        uint256 n = markets.length;
        if (n == 0 || n > MAX_STRATEGIES || minDiscountBps.length != n || maxShareBps.length != n) revert BadParams();
        asset = asset_;
        assetDecimals = IERC20Metadata(address(asset_)).decimals();
        for (uint256 i; i < n; i++) {
            ExitMarket m = markets[i];
            // Same denomination only: the vault asset is the receipt's underlying.
            if (m.underlying() != address(asset_)) revert BadParams();
            if (maxShareBps[i] == 0 || maxShareBps[i] > BPS || minDiscountBps[i] > m.MAX_DISCOUNT_BPS()) {
                revert BadParams();
            }
            IERC20 r = m.receipt();
            for (uint256 j; j < i; j++) {
                if (strategies_[j].receipt == r) revert BadParams();
            }
            strategies_.push(
                Strategy({
                    market: m,
                    receipt: r,
                    minDiscountBps: minDiscountBps[i],
                    maxShareBps: maxShareBps[i],
                    payIdx: _payIndex(m, address(asset_))
                })
            );
            bidOf.push(0);
            asset_.forceApprove(address(m), type(uint256).max);
            r.forceApprove(address(m), type(uint256).max);
        }
    }

    function _payIndex(ExitMarket m, address token) internal view returns (uint8) {
        address[] memory list = m.payTokens();
        for (uint256 i; i < list.length; i++) {
            if (list[i] == token) return uint8(i);
        }
        revert BadParams();
    }

    function decimals() public view override returns (uint8) {
        return assetDecimals + DECIMALS_OFFSET;
    }

    /* ------------------------------------------------------------------ */
    /*                              Views                                  */
    /* ------------------------------------------------------------------ */

    function strategiesLength() external view returns (uint256) {
        return strategies_.length;
    }

    function strategy(uint256 i) external view returns (Strategy memory) {
        return strategies_[i];
    }

    /// @notice Capital waiting to buy: vault balance plus escrow of its live bids.
    function idleAssets() public view returns (uint256 idle) {
        idle = asset.balanceOf(address(this));
        for (uint256 i; i < strategies_.length; i++) {
            idle += _escrowOf(i);
        }
    }

    /// @notice Face value of receipts held for strategy `i`, in the vault asset.
    function heldAssets(uint256 i) public view returns (uint256) {
        Strategy storage s = strategies_[i];
        return s.market.receiptValue(s.receipt.balanceOf(address(this)));
    }

    function totalAssets() public view returns (uint256 total) {
        total = idleAssets();
        for (uint256 i; i < strategies_.length; i++) {
            total += heldAssets(i);
        }
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, totalAssets() + 1);
    }

    /// @notice What `shares` redeem for: vault asset now, and receipt tokens in kind per strategy.
    function previewRedeem(uint256 shares) public view returns (uint256 assets, uint256[] memory receipts) {
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        assets = Math.mulDiv(idleAssets(), shares, denom);
        receipts = new uint256[](strategies_.length);
        for (uint256 i; i < strategies_.length; i++) {
            receipts[i] = Math.mulDiv(strategies_[i].receipt.balanceOf(address(this)), shares, denom);
        }
    }

    function _escrowOf(uint256 i) internal view returns (uint256) {
        uint256 id = bidOf[i];
        if (id == 0) return 0;
        (address bidder,,,, uint256 escrow) = strategies_[i].market.bids(id);
        return bidder == address(this) ? escrow : 0;
    }

    /* ------------------------------------------------------------------ */
    /*                         Depositor actions                           */
    /* ------------------------------------------------------------------ */

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroShares();
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
        _refreshBids();
    }

    /// @notice Redeems `shares` at any time: idle capital in the vault asset, held receipts in kind.
    function redeem(uint256 shares, address receiver, address owner)
        external
        nonReentrant
        returns (uint256 assets, uint256[] memory receipts)
    {
        if (shares == 0) revert ZeroShares();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _cancelBids();
        (assets, receipts) = previewRedeem(shares);
        _burn(owner, shares);
        if (assets > 0) asset.safeTransfer(receiver, assets);
        for (uint256 i; i < receipts.length; i++) {
            if (receipts[i] > 0) strategies_[i].receipt.safeTransfer(receiver, receipts[i]);
        }
        emit Redeem(msg.sender, receiver, owner, shares, assets, receipts);
        _refreshBids();
    }

    /* ------------------------------------------------------------------ */
    /*                        Permissionless upkeep                        */
    /* ------------------------------------------------------------------ */

    /// @notice Redeems held receipts of strategy `i` once the pool is liquid again. Anyone can call.
    /// @param assets Face value to redeem; capped at what the vault holds.
    function recover(uint256 i, uint256 assets) external nonReentrant returns (uint256) {
        uint256 held = heldAssets(i);
        if (assets > held) assets = held;
        if (assets == 0) revert ZeroAmount();
        strategies_[i].market.redeemReceipt(assets, address(this));
        emit Recovered(i, msg.sender, assets);
        _refreshBids();
        return assets;
    }

    /// @notice Re-sizes the vault's bids to the current capital, e.g. after a fill. Anyone can call.
    function refreshBids() external nonReentrant {
        _refreshBids();
    }

    function _cancelBids() internal {
        for (uint256 i; i < strategies_.length; i++) {
            uint256 id = bidOf[i];
            if (id == 0) continue;
            bidOf[i] = 0;
            (address bidder,,,,) = strategies_[i].market.bids(id);
            if (bidder == address(this)) strategies_[i].market.cancelBid(id);
        }
    }

    /// @dev Each strategy bids with the idle capital left, up to its cap minus receipts already held.
    function _refreshBids() internal {
        _cancelBids();
        uint256 total = totalAssets();
        uint256 idle = asset.balanceOf(address(this));
        for (uint256 i; i < strategies_.length && idle > 0; i++) {
            Strategy storage s = strategies_[i];
            uint256 cap = Math.mulDiv(total, s.maxShareBps, BPS);
            uint256 held = heldAssets(i);
            if (held >= cap) continue;
            uint256 room = cap - held;
            uint256 escrow = idle < room ? idle : room;
            if (escrow == 0) continue;
            bidOf[i] = s.market.placeBid(s.minDiscountBps, s.payIdx, room, escrow);
            idle -= escrow;
        }
        emit BidsRefreshed(total, idleAssets());
    }
}
