// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {AaveExitMarket} from "../venues/aave/AaveExitMarket.sol";
import {IAavePool, IFlashLoanSimpleReceiver} from "../shared/interfaces/IAaveV3.sol";

/// @title AaveCollateralRoute
/// @notice Fallback for Aave borrowers whose collateral sits in a pool that cannot be withdrawn from:
///         sell the collateral aToken into escrowed bids on the exit market instead of withdrawing it,
///         then repay debt or post the proceeds as new collateral, in one transaction.
/// @dev The caller approves this route for their collateral aToken. The route only ever acts for msg.sender.
contract AaveCollateralRoute is IFlashLoanSimpleReceiver, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant VARIABLE_RATE = 2;
    uint256 internal constant RAY = 1e27;

    IAavePool public immutable pool;

    address private transient ctxUser;
    address private transient ctxMarket;
    uint256 private transient ctxAmount;
    uint8 private transient ctxPayIdx;
    uint16 private transient ctxMaxDiscount;
    bool private transient ctxActive;
    uint256[] private ctxBidIds;

    event CollateralSoldForRepay(
        address indexed user, address indexed market, uint256 collateralSold, address debtAsset, uint256 repaid
    );
    event CollateralSwapped(
        address indexed user, address indexed market, uint256 collateralSold, address newCollateral, uint256 supplied
    );

    error UnexpectedCallback();
    error ProceedsTooLow(uint256 proceeds, uint256 needed);
    error ZeroAmount();

    constructor(IAavePool pool_) {
        pool = pool_;
    }

    /// @notice Repays `repayAmount` of the caller's `debtAsset` debt and pays for it by selling up to
    ///         `collateralAmount` of frozen collateral into bids that pay in `debtAsset`.
    /// @dev Repays first with an Aave flash loan of `debtAsset`, so the health factor never dips mid-way.
    ///      Unsold collateral and surplus proceeds go back to the caller.
    function repayWithFrozenCollateral(
        AaveExitMarket market,
        uint256 collateralAmount,
        uint256[] calldata bidIds,
        uint16 maxDiscountBps,
        uint8 payIdx,
        uint256 repayAmount
    ) external nonReentrant returns (uint256 sold) {
        if (collateralAmount == 0 || repayAmount == 0) revert ZeroAmount();
        address debtAsset = market.payTokens()[payIdx];
        IERC20 collateral = market.receipt();

        ctxUser = msg.sender;
        ctxMarket = address(market);
        ctxAmount = collateralAmount;
        ctxPayIdx = payIdx;
        ctxMaxDiscount = maxDiscountBps;
        ctxActive = true;
        ctxBidIds = bidIds;
        uint256 before = collateral.balanceOf(address(this));
        pool.flashLoanSimple(address(this), debtAsset, repayAmount, "", 0);
        ctxActive = false;
        delete ctxBidIds;

        uint256 unsold = collateral.balanceOf(address(this)) - before;
        sold = unsold >= collateralAmount ? 0 : collateralAmount - unsold;
        if (unsold > 0) collateral.safeTransfer(msg.sender, unsold);
        uint256 surplus = IERC20(debtAsset).balanceOf(address(this));
        if (surplus > 0) IERC20(debtAsset).safeTransfer(msg.sender, surplus);
        emit CollateralSoldForRepay(msg.sender, address(market), sold, debtAsset, repayAmount);
    }

    /// @inheritdoc IFlashLoanSimpleReceiver
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata)
        external
        returns (bool)
    {
        if (msg.sender != address(pool) || initiator != address(this) || !ctxActive) revert UnexpectedCallback();
        address user = ctxUser;
        AaveExitMarket market = AaveExitMarket(ctxMarket);

        IERC20(asset).forceApprove(address(pool), amount + premium);
        pool.repay(asset, amount, VARIABLE_RATE, user);

        _sell(market, user, ctxAmount, ctxPayIdx, ctxMaxDiscount, ctxBidIds);

        uint256 balance = IERC20(asset).balanceOf(address(this));
        if (balance < amount + premium) revert ProceedsTooLow(balance, amount + premium);
        IERC20(asset).forceApprove(address(pool), amount + premium);
        return true;
    }

    /// @notice Swaps frozen collateral for new collateral: sells up to `collateralAmount` into bids paying in
    ///         the token at `payIdx` and supplies the proceeds to Aave on the caller's behalf.
    /// @dev Aave checks the caller's health factor when the collateral leaves; the new collateral lands after.
    function swapFrozenCollateral(
        AaveExitMarket market,
        uint256 collateralAmount,
        uint256[] calldata bidIds,
        uint16 maxDiscountBps,
        uint8 payIdx,
        uint256 minProceeds
    ) external nonReentrant returns (uint256 sold, uint256 supplied) {
        if (collateralAmount == 0) revert ZeroAmount();
        address newCollateral = market.payTokens()[payIdx];
        IERC20 collateral = market.receipt();
        uint256 before = collateral.balanceOf(address(this));

        _sell(market, msg.sender, collateralAmount, payIdx, maxDiscountBps, bidIds);

        supplied = IERC20(newCollateral).balanceOf(address(this));
        if (supplied < minProceeds) revert ProceedsTooLow(supplied, minProceeds);
        IERC20(newCollateral).forceApprove(address(pool), supplied);
        pool.supply(newCollateral, supplied, msg.sender, 0);

        uint256 unsold = collateral.balanceOf(address(this)) - before;
        sold = unsold >= collateralAmount ? 0 : collateralAmount - unsold;
        if (unsold > 0) collateral.safeTransfer(msg.sender, unsold);
        emit CollateralSwapped(msg.sender, address(market), sold, newCollateral, supplied);
    }

    function _sell(
        AaveExitMarket market,
        address user,
        uint256 collateralAmount,
        uint8 payIdx,
        uint16 maxDiscountBps,
        uint256[] memory bidIds
    ) internal {
        IERC20 collateral = market.receipt();
        collateral.safeTransferFrom(user, address(this), collateralAmount);
        // Each split transfer of an aToken can round up by one scaled unit; keep that margin unsold.
        uint256 margin = bidIds.length * (pool.getReserveNormalizedIncome(market.underlying()) / RAY + 1);
        if (collateralAmount <= margin) revert ZeroAmount();
        collateral.forceApprove(address(market), collateralAmount);
        market.sellNow(collateralAmount - margin, bidIds, maxDiscountBps, uint8(1 << payIdx), 0);
        collateral.forceApprove(address(market), 0);
    }
}
