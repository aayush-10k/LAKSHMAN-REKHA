// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct PaymentRequest {
    uint256 amountMinor;
    address counterparty;
    uint8   counterpartyTier;
    uint16  counterpartyAgeDays;
    uint32  counterpartySettledTxns;
    int8    priceBandZ;
    uint8   categoryCode;
    bytes32 leaseId;
    uint64  nonce;
    uint64  revocationEpoch;
    uint64  leaseExpiry;
}
