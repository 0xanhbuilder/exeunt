// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

/// @notice Immutable token => USD feed registry. Prices are normalised to 8 decimals.
/// @dev Feeds are fixed at deployment; there is no owner and no way to change them.
contract PriceRouter {
    error FeedMissing(address token);
    error BadPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    error LengthMismatch();

    uint256 public immutable maxAge;
    mapping(address => address) public feedOf;

    constructor(address[] memory tokens, address[] memory feeds, uint256 maxAge_) {
        if (tokens.length != feeds.length) revert LengthMismatch();
        maxAge = maxAge_;
        for (uint256 i; i < tokens.length; i++) {
            feedOf[tokens[i]] = feeds[i];
        }
    }

    /// @notice USD price of `token` with 8 decimals.
    function priceOf(address token) external view returns (uint256) {
        address feed = feedOf[token];
        if (feed == address(0)) revert FeedMissing(token);
        (, int256 answer,, uint256 updatedAt,) = IPriceFeed(feed).latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        if (block.timestamp > updatedAt + maxAge) revert StalePrice(token, updatedAt);
        uint8 dec = IPriceFeed(feed).decimals();
        uint256 price = uint256(answer);
        if (dec > 8) return price / 10 ** (dec - 8);
        if (dec < 8) return price * 10 ** (8 - dec);
        return price;
    }
}
