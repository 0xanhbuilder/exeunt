// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceRouter} from "../shared/oracle/PriceRouter.sol";

/// @title ExitMarket
/// @notice Venue-agnostic exit market for deposit receipts of frozen lending pools.
/// @dev Sellers escrow receipts into Dutch-auction sessions or sell straight into escrowed limit bids.
///      Borrowers of the same asset buy receipts at a discount: the market flash-borrows the underlying,
///      repays their debt on their behalf and redeems the seller's receipts with the liquidity that the
///      repayment creates, so the pool's withdrawable liquidity is unchanged. Venue specifics (Aave, Morpho)
///      live in the derived contracts. There is no owner and no admin function.
abstract contract ExitMarket is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_DISCOUNT_BPS = 5_000;
    uint32 public constant MAX_SESSION_DURATION = 30 days;
    uint256 public constant MAX_PAY_TOKENS = 8;

    enum PayMode {
        Wallet,
        Collateral
    }

    struct SessionParams {
        uint16 startBps;
        uint16 stepBps;
        uint32 stepInterval;
        uint16 capBps;
        uint32 duration;
        uint8 payMask;
    }

    struct Session {
        address seller;
        uint64 startedAt;
        uint64 endsAt;
        uint16 startBps;
        uint16 stepBps;
        uint16 capBps;
        uint8 payMask;
        uint32 stepInterval;
        uint256 units;
    }

    struct Bid {
        address bidder;
        uint16 minDiscountBps;
        uint8 payIdx;
        uint256 maxAssets;
        uint256 escrow;
    }

    /// @notice Exit capacity of the pool that issues the receipt, in underlying units.
    struct Capacity {
        uint256 withdrawable;
        uint256 supplied;
        uint256 utilizationBps;
        uint256 debtorCapacity;
        uint256 sessionAssets;
    }

    /// @notice Receipt token sold on this market (an aToken or vault share).
    IERC20 public immutable receipt;
    /// @notice Asset the receipt is redeemable for.
    address public immutable underlying;
    PriceRouter public immutable prices;
    uint8 internal immutable underlyingDecimals;

    address[] internal payTokens_;

    uint256 public nextSessionId = 1;
    uint256 public nextBidId = 1;
    mapping(uint256 => Session) public sessions;
    mapping(uint256 => Bid) public bids;
    /// @notice Escrow held for limit bids, per payment token.
    mapping(address => uint256) public totalEscrow;
    /// @notice Receipt units escrowed in sessions.
    uint256 public totalSessionUnits;

    uint256[] internal activeBidIds_;
    mapping(uint256 => uint256) internal activeBidPos_; // index + 1

    event SessionOpened(
        uint256 indexed sessionId, address indexed seller, uint256 assets, uint256 units, SessionParams params
    );
    event UnsoldWithdrawn(uint256 indexed sessionId, address indexed seller, uint256 units, uint256 assets);
    event Bought(
        uint256 indexed sessionId,
        address indexed buyer,
        uint256 assets,
        uint256 debtRepaid,
        uint16 discountBps,
        address payToken,
        uint256 paid,
        PayMode mode
    );
    event BidPlaced(
        uint256 indexed bidId,
        address indexed bidder,
        uint16 minDiscountBps,
        address payToken,
        uint256 maxAssets,
        uint256 escrow
    );
    event BidCancelled(uint256 indexed bidId, address indexed bidder, uint256 refunded);
    event BidFilled(
        uint256 indexed bidId,
        uint256 indexed sessionId,
        address indexed seller,
        uint256 assets,
        uint256 paid,
        uint16 discountBps
    );
    event ReceiptRedeemed(address indexed holder, address indexed to, uint256 assets);

    error ZeroAmount();
    error BadParams();
    error NotSeller();
    error NotBidder();
    error SessionClosed();
    error PayTokenNotAccepted();
    error PriceTooHigh(uint256 price, uint256 maxPay);
    error DebtTooSmall(uint256 debt, uint256 assets);
    error NotEnoughUnits();
    error DiscountBelowBid();
    error UnknownBid();
    error InsufficientFill(uint256 filled, uint256 minFilled);
    error HealthDecreased(uint256 before, uint256 afterwards);
    error SamePaymentAsset();
    error EscrowTouched();

    constructor(IERC20 receipt_, address underlying_, PriceRouter prices_, address[] memory payTokenList) {
        if (payTokenList.length == 0 || payTokenList.length > MAX_PAY_TOKENS) revert BadParams();
        for (uint256 i; i < payTokenList.length; i++) {
            if (payTokenList[i] == address(0) || payTokenList[i] == address(receipt_)) revert BadParams();
            for (uint256 j; j < i; j++) {
                if (payTokenList[j] == payTokenList[i]) revert BadParams();
            }
            if (payTokenList[i] != underlying_) {
                if (prices_.feedOf(payTokenList[i]) == address(0) || prices_.feedOf(underlying_) == address(0)) {
                    revert BadParams();
                }
            }
        }
        receipt = receipt_;
        underlying = underlying_;
        prices = prices_;
        underlyingDecimals = IERC20Metadata(underlying_).decimals();
        payTokens_ = payTokenList;
    }

    /* ------------------------------------------------------------------ */
    /*                           Venue hooks                               */
    /* ------------------------------------------------------------------ */

    /// @dev Receipt units held by `account` (Aave: scaled balance, vault: shares).
    function _unitsOf(address account) internal view virtual returns (uint256);

    /// @dev Underlying value of `units`, rounded down.
    function _unitsToAssets(uint256 units) internal view virtual returns (uint256);

    function _assetsToUnits(uint256 assets, bool roundUp) internal view virtual returns (uint256);

    /// @dev Moves at most `units` escrowed receipt units from the market to `to`.
    function _pushUnits(address to, uint256 units) internal virtual;

    /// @dev Moves receipts worth `assets` straight from `from` to `to` (seller to bidder).
    function _transferReceiptFrom(address from, address to, uint256 assets) internal virtual;

    /// @dev Current same-asset debt of `borrower`.
    function _debtOf(address borrower, bytes calldata venueData) internal view virtual returns (uint256);

    /// @dev Repays `borrower` debt with flash liquidity and redeems escrowed receipts worth `assets` to return it.
    /// @return debtRepaid Debt actually repaid (`assets` minus any flash or exit fee).
    function _repayFor(address borrower, uint256 assets, bytes calldata venueData)
        internal
        virtual
        returns (uint256 debtRepaid);

    /// @dev Takes `amount` of `payToken` from the buyer's freed collateral and sends it to `to`.
    function _payWithCollateral(address buyer, address payToken, uint256 amount, address to, bytes calldata venueData)
        internal
        virtual;

    /// @dev Health metric where higher is safer (Aave health factor, Morpho max borrow over debt).
    function _healthOf(address borrower, bytes calldata venueData) internal view virtual returns (uint256);

    /// @dev Pulls receipts worth `assets` from `holder`, redeems them and sends the underlying to `to`.
    function _redeemFrom(address holder, uint256 assets, address to) internal virtual;

    /// @dev Pool statistics: withdrawable now, total supplied, same-asset debt that can absorb receipts.
    function _poolStats() internal view virtual returns (uint256 withdrawable, uint256 supplied, uint256 borrowed);

    /* ------------------------------------------------------------------ */
    /*                             Sessions                                */
    /* ------------------------------------------------------------------ */

    /// @notice Escrows `amount` receipt tokens and opens a Dutch auction whose discount only rises.
    function openSession(uint256 amount, SessionParams calldata p) external nonReentrant returns (uint256 sessionId) {
        if (amount == 0) revert ZeroAmount();
        if (
            p.capBps > MAX_DISCOUNT_BPS || p.startBps > p.capBps || p.stepInterval == 0 || p.duration == 0
                || p.duration > MAX_SESSION_DURATION || p.payMask == 0 || p.payMask >> payTokens_.length != 0
        ) revert BadParams();

        uint256 before = _unitsOf(address(this));
        receipt.safeTransferFrom(msg.sender, address(this), amount);
        uint256 units = _unitsOf(address(this)) - before;
        if (units == 0) revert ZeroAmount();

        sessionId = nextSessionId++;
        sessions[sessionId] = Session({
            seller: msg.sender,
            startedAt: uint64(block.timestamp),
            endsAt: uint64(block.timestamp + p.duration),
            startBps: p.startBps,
            stepBps: p.stepBps,
            capBps: p.capBps,
            payMask: p.payMask,
            stepInterval: p.stepInterval,
            units: units
        });
        totalSessionUnits += units;
        emit SessionOpened(sessionId, msg.sender, _unitsToAssets(units), units, p);
    }

    /// @notice Returns unsold receipts to the seller at any time. `units == type(uint256).max` withdraws all.
    function withdrawUnsold(uint256 sessionId, uint256 units) external nonReentrant returns (uint256 assets) {
        Session storage s = sessions[sessionId];
        if (s.seller != msg.sender) revert NotSeller();
        if (units == type(uint256).max) units = s.units;
        if (units == 0) revert ZeroAmount();
        if (units > s.units) revert NotEnoughUnits();
        s.units -= units;
        totalSessionUnits -= units;
        assets = _unitsToAssets(units);
        _pushUnits(msg.sender, units);
        emit UnsoldWithdrawn(sessionId, msg.sender, units, assets);
    }

    /// @notice Current discount of a session in basis points. It never decreases over time.
    function discountOf(uint256 sessionId) public view returns (uint16) {
        Session storage s = sessions[sessionId];
        if (s.seller == address(0)) return 0;
        uint256 d = uint256(s.startBps) + ((block.timestamp - s.startedAt) / s.stepInterval) * s.stepBps;
        return uint16(d > s.capBps ? s.capBps : d);
    }

    function remainingAssets(uint256 sessionId) public view returns (uint256) {
        return _unitsToAssets(sessions[sessionId].units);
    }

    function isOpen(uint256 sessionId) public view returns (bool) {
        Session storage s = sessions[sessionId];
        return s.seller != address(0) && block.timestamp < s.endsAt && s.units > 0;
    }

    /* ------------------------------------------------------------------ */
    /*                     Borrowers buy and repay                         */
    /* ------------------------------------------------------------------ */

    /// @notice Buys receipts worth `assets` at the session's current discount, paying from the wallet.
    /// @dev The buyer's same-asset debt is repaid in the same transaction by `assets` minus any flash fee.
    function buyAndRepay(uint256 sessionId, uint256 assets, uint8 payIdx, uint256 maxPay, bytes calldata venueData)
        external
        nonReentrant
        returns (uint256 paid, uint256 debtRepaid)
    {
        Session storage s = sessions[sessionId];
        (address payToken, uint16 d, uint256 price) = _prepareBuy(s, sessionId, assets, payIdx, maxPay, venueData);
        paid = price;
        debtRepaid = _settleRepay(s, msg.sender, assets, venueData);
        IERC20(payToken).safeTransferFrom(msg.sender, s.seller, paid);
        emit Bought(sessionId, msg.sender, assets, debtRepaid, d, payToken, paid, PayMode.Wallet);
    }

    /// @notice Flash mode: buys receipts and pays the seller with collateral that the repayment frees.
    /// @dev The buyer needs no cash. Reverts if the buyer's health would decrease.
    function buyAndRepayWithCollateral(
        uint256 sessionId,
        uint256 assets,
        uint8 payIdx,
        uint256 maxPay,
        bytes calldata venueData
    ) external nonReentrant returns (uint256 paid, uint256 debtRepaid) {
        Session storage s = sessions[sessionId];
        (address payToken, uint16 d, uint256 price) = _prepareBuy(s, sessionId, assets, payIdx, maxPay, venueData);
        if (payToken == underlying) revert SamePaymentAsset();
        paid = price;

        uint256 healthBefore = _healthOf(msg.sender, venueData);
        debtRepaid = _settleRepay(s, msg.sender, assets, venueData);
        _payWithCollateral(msg.sender, payToken, paid, s.seller, venueData);
        uint256 healthAfter = _healthOf(msg.sender, venueData);
        if (healthAfter < healthBefore) revert HealthDecreased(healthBefore, healthAfter);

        emit Bought(sessionId, msg.sender, assets, debtRepaid, d, payToken, paid, PayMode.Collateral);
    }

    function _prepareBuy(
        Session storage s,
        uint256 sessionId,
        uint256 assets,
        uint8 payIdx,
        uint256 maxPay,
        bytes calldata venueData
    ) internal view returns (address payToken, uint16 d, uint256 price) {
        if (assets == 0) revert ZeroAmount();
        if (!isOpen(sessionId)) revert SessionClosed();
        if (payIdx >= payTokens_.length || (s.payMask >> payIdx) & 1 == 0) revert PayTokenNotAccepted();
        if (assets > _unitsToAssets(s.units)) revert NotEnoughUnits();
        uint256 debt = _debtOf(msg.sender, venueData);
        if (debt < assets) revert DebtTooSmall(debt, assets);
        payToken = payTokens_[payIdx];
        d = discountOf(sessionId);
        price = quote(assets, d, payToken);
        if (price > maxPay) revert PriceTooHigh(price, maxPay);
    }

    function _settleRepay(Session storage s, address buyer, uint256 assets, bytes calldata venueData)
        internal
        returns (uint256 debtRepaid)
    {
        uint256 before = _unitsOf(address(this));
        debtRepaid = _repayFor(buyer, assets, venueData);
        uint256 burned = before - _unitsOf(address(this));
        if (burned > s.units) revert NotEnoughUnits();
        s.units -= burned;
        totalSessionUnits -= burned;
    }

    /* ------------------------------------------------------------------ */
    /*                            Limit bids                               */
    /* ------------------------------------------------------------------ */

    /// @notice Places an escrowed limit bid for receipts at a discount of at least `minDiscountBps`.
    /// @param maxAssets Maximum receipt value (in underlying units) the bid buys.
    function placeBid(uint16 minDiscountBps, uint8 payIdx, uint256 maxAssets, uint256 escrow)
        external
        nonReentrant
        returns (uint256 bidId)
    {
        if (maxAssets == 0 || escrow == 0) revert ZeroAmount();
        if (minDiscountBps > MAX_DISCOUNT_BPS || payIdx >= payTokens_.length) revert BadParams();
        address payToken = payTokens_[payIdx];
        IERC20(payToken).safeTransferFrom(msg.sender, address(this), escrow);
        totalEscrow[payToken] += escrow;

        bidId = nextBidId++;
        bids[bidId] = Bid({
            bidder: msg.sender, minDiscountBps: minDiscountBps, payIdx: payIdx, maxAssets: maxAssets, escrow: escrow
        });
        activeBidIds_.push(bidId);
        activeBidPos_[bidId] = activeBidIds_.length;
        emit BidPlaced(bidId, msg.sender, minDiscountBps, payToken, maxAssets, escrow);
    }

    /// @notice Cancels a bid and refunds the unused escrow immediately.
    function cancelBid(uint256 bidId) external nonReentrant returns (uint256 refunded) {
        Bid storage b = bids[bidId];
        if (b.bidder != msg.sender) revert NotBidder();
        refunded = _closeBid(bidId, b);
        emit BidCancelled(bidId, msg.sender, refunded);
    }

    /// @notice Receipt value (underlying units) bid `bidId` can still buy at `discountBps`.
    function bidCapacity(uint256 bidId, uint16 discountBps) public view returns (uint256) {
        Bid storage b = bids[bidId];
        if (b.bidder == address(0)) return 0;
        uint256 affordable = assetsFor(b.escrow, discountBps, payTokens_[b.payIdx]);
        return affordable < b.maxAssets ? affordable : b.maxAssets;
    }

    /// @notice Sells receipts worth up to `assets` from the caller's wallet into the given bids, in order.
    /// @dev Each bid fills at its own limit price. Bids above `maxDiscountBps` or paying in a token outside
    ///      `payMask` are skipped. Reverts if less than `minFilled` is sold.
    function sellNow(uint256 assets, uint256[] calldata bidIds, uint16 maxDiscountBps, uint8 payMask, uint256 minFilled)
        external
        nonReentrant
        returns (uint256 filled, uint256[] memory paid)
    {
        if (assets == 0) revert ZeroAmount();
        paid = new uint256[](bidIds.length);
        for (uint256 i; i < bidIds.length && filled < assets; i++) {
            uint256 bidId = bidIds[i];
            Bid storage b = bids[bidId];
            if (b.bidder == address(0) || b.minDiscountBps > maxDiscountBps || (payMask >> b.payIdx) & 1 == 0) {
                continue;
            }
            uint256 f = bidCapacity(bidId, b.minDiscountBps);
            if (f > assets - filled) f = assets - filled;
            if (f == 0) continue;
            address payToken = payTokens_[b.payIdx];
            uint256 pay = quote(f, b.minDiscountBps, payToken);
            if (pay > b.escrow) pay = b.escrow;
            _consumeBid(b, f, pay);
            filled += f;
            paid[i] = pay;
            _transferReceiptFrom(msg.sender, b.bidder, f);
            IERC20(payToken).safeTransfer(msg.sender, pay);
            emit BidFilled(bidId, 0, msg.sender, f, pay, b.minDiscountBps);
            if (bidCapacity(bidId, b.minDiscountBps) == 0) _autoClose(bidId, b);
        }
        if (filled < minFilled) revert InsufficientFill(filled, minFilled);
    }

    /// @notice Fills a bid from a session once the session's discount reaches the bid's limit.
    /// @dev Callable by anyone. The bid pays the session's current price, which is at or below its limit price.
    function matchBid(uint256 sessionId, uint256 bidId, uint256 assets)
        external
        nonReentrant
        returns (uint256 filled, uint256 paid)
    {
        Session storage s = sessions[sessionId];
        Bid storage b = bids[bidId];
        if (b.bidder == address(0)) revert UnknownBid();
        if (!isOpen(sessionId)) revert SessionClosed();
        if ((s.payMask >> b.payIdx) & 1 == 0) revert PayTokenNotAccepted();
        uint16 d = discountOf(sessionId);
        if (d < b.minDiscountBps) revert DiscountBelowBid();

        filled = bidCapacity(bidId, d);
        uint256 remaining = _unitsToAssets(s.units);
        if (filled > remaining) filled = remaining;
        if (filled > assets) filled = assets;
        if (filled == 0) revert ZeroAmount();

        uint256 units = _assetsToUnits(filled, true);
        if (units > s.units) units = s.units;
        address payToken = payTokens_[b.payIdx];
        paid = quote(filled, d, payToken);
        if (paid > b.escrow) paid = b.escrow;
        _consumeBid(b, filled, paid);
        s.units -= units;
        totalSessionUnits -= units;
        _pushUnits(b.bidder, units);
        IERC20(payToken).safeTransfer(s.seller, paid);
        emit BidFilled(bidId, sessionId, s.seller, filled, paid, d);
        if (bidCapacity(bidId, b.minDiscountBps) == 0) _autoClose(bidId, b);
    }

    function _consumeBid(Bid storage b, uint256 assets, uint256 pay) internal {
        b.escrow -= pay;
        b.maxAssets -= assets;
        totalEscrow[payTokens_[b.payIdx]] -= pay;
    }

    function _autoClose(uint256 bidId, Bid storage b) internal {
        address bidder = b.bidder;
        uint256 refunded = _closeBid(bidId, b);
        emit BidCancelled(bidId, bidder, refunded);
    }

    function _closeBid(uint256 bidId, Bid storage b) internal returns (uint256 refunded) {
        address bidder = b.bidder;
        address payToken = payTokens_[b.payIdx];
        refunded = b.escrow;
        totalEscrow[payToken] -= refunded;
        delete bids[bidId];

        uint256 pos = activeBidPos_[bidId];
        uint256 last = activeBidIds_[activeBidIds_.length - 1];
        activeBidIds_[pos - 1] = last;
        activeBidPos_[last] = pos;
        activeBidIds_.pop();
        delete activeBidPos_[bidId];

        if (refunded > 0) IERC20(payToken).safeTransfer(bidder, refunded);
    }

    /* ------------------------------------------------------------------ */
    /*                            Recovery                                 */
    /* ------------------------------------------------------------------ */

    /// @notice Pulls the caller's receipts worth `assets`, redeems them and sends the underlying to `to`.
    /// @dev Works only while the pool has liquidity. Lets holders such as the Exeunt Vault recover the
    ///      underlying through one venue-agnostic call. Escrowed receipts are never touched.
    function redeemReceipt(uint256 assets, address to) external nonReentrant returns (uint256) {
        if (assets == 0) revert ZeroAmount();
        _redeemFrom(msg.sender, assets, to);
        if (_unitsOf(address(this)) < totalSessionUnits) revert EscrowTouched();
        emit ReceiptRedeemed(msg.sender, to, assets);
        return assets;
    }

    /* ------------------------------------------------------------------ */
    /*                              Pricing                                */
    /* ------------------------------------------------------------------ */

    /// @notice Amount of `payToken` that buys receipts worth `assets` at `discountBps`. Rounds up.
    function quote(uint256 assets, uint16 discountBps, address payToken) public view returns (uint256) {
        uint256 net = assets * (BPS - discountBps);
        if (payToken == underlying) return Math.ceilDiv(net, BPS);
        uint256 pu = prices.priceOf(underlying);
        uint256 pp = prices.priceOf(payToken);
        uint256 dp = IERC20Metadata(payToken).decimals();
        return Math.mulDiv(net * pu, 10 ** dp, pp * 10 ** underlyingDecimals * BPS, Math.Rounding.Ceil);
    }

    /// @notice Receipt value that `payAmount` of `payToken` buys at `discountBps`. Rounds down.
    function assetsFor(uint256 payAmount, uint16 discountBps, address payToken) public view returns (uint256) {
        if (payAmount == 0) return 0;
        uint256 keep = BPS - discountBps;
        if (payToken == underlying) return Math.mulDiv(payAmount, BPS, keep);
        uint256 pu = prices.priceOf(underlying);
        uint256 pp = prices.priceOf(payToken);
        uint256 dp = IERC20Metadata(payToken).decimals();
        return Math.mulDiv(payAmount * pp, 10 ** underlyingDecimals * BPS, pu * keep * 10 ** dp);
    }

    /* ------------------------------------------------------------------ */
    /*                               Views                                 */
    /* ------------------------------------------------------------------ */

    /// @notice Underlying value of `amount` receipt tokens.
    function receiptValue(uint256 amount) public view virtual returns (uint256);

    /// @notice Exit capacity of the pool, readable by anyone on-chain.
    function capacity() external view returns (Capacity memory c) {
        (uint256 withdrawable, uint256 supplied, uint256 borrowed) = _poolStats();
        c.withdrawable = withdrawable;
        c.supplied = supplied;
        c.utilizationBps = supplied == 0 || withdrawable >= supplied ? 0 : (supplied - withdrawable) * BPS / supplied;
        c.debtorCapacity = borrowed;
        c.sessionAssets = _unitsToAssets(totalSessionUnits);
    }

    /// @notice Receipt value escrowed bids buy when a seller accepts up to `discountBps`, counting only escrow.
    function bidCapacityAt(uint16 discountBps) external view returns (uint256 total) {
        for (uint256 i; i < activeBidIds_.length; i++) {
            Bid storage b = bids[activeBidIds_[i]];
            if (b.minDiscountBps <= discountBps) total += bidCapacity(activeBidIds_[i], b.minDiscountBps);
        }
    }

    function payTokens() external view returns (address[] memory) {
        return payTokens_;
    }

    function activeBidIds() external view returns (uint256[] memory) {
        return activeBidIds_;
    }
}
