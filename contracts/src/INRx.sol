// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title INRx — the Rekha Rupee ledger
/// @notice ERC-20 token with 2 decimals representing Indian Rupees in minor units
///         (paise). ₹9,400 is 940000. This is the on-chain rupee ledger for the
///         Lakshman Rekha spend-control system. Owner-mintable only.
/// @dev Deliberately minimal: OpenZeppelin ERC20 + Ownable. All accounting in the
///      wider system is done in `uint256` minor units (paise); the 2 decimals here
///      mirror that so token balances read as rupees on explorers.
contract INRx is ERC20, Ownable {
    /// @notice Deploys the Rekha Rupee token.
    /// @param initialOwner The address granted mint authority and Ownable ownership.
    constructor(address initialOwner) ERC20("Rekha Rupee", "INRx") Ownable(initialOwner) {}

    /// @notice Number of decimals for the token. Two decimals = paise precision.
    /// @return The fixed decimal count of 2.
    function decimals() public pure override returns (uint8) {
        return 2;
    }

    /// @notice Mints new INRx to an account. Only the owner may mint.
    /// @param to The recipient of the newly minted tokens.
    /// @param amountMinor The amount to mint, in minor units (paise).
    function mint(address to, uint256 amountMinor) external onlyOwner {
        _mint(to, amountMinor);
    }
}
