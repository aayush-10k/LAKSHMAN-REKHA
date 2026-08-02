// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The single, canonical spend request evaluated by the policy layer.
/// @dev Deliberately contains NO string / bytes / free-text field. The security
///      model depends on the policy layer being unable to read attacker-authored
///      text. Counterparty age and settled-count are numeric values sourced from a
///      registry off-chain and vouched for by the dual (agent + core) signature —
///      they are never invented by the agent. All money is `uint256` minor units
///      (paise): ₹9,400 == 940000. Every field except free-text is fair game; the
///      one hard rule remains: no string / bytes / attacker-authored text.
///      `coreImageDigest` is the code image the core claims to be running; the
///      policy re-checks it against the registered approved image (predicate 3).
struct PaymentRequest {
    uint256 amountMinor;
    address counterparty;
    uint8 counterpartyTier;
    uint16 counterpartyAgeDays;
    uint32 counterpartySettledTxns;
    int8 priceBandZ;
    uint8 categoryCode;
    bytes32 leaseId;
    uint64 nonce;
    uint64 revocationEpoch;
    uint64 leaseExpiry;
    bytes32 coreImageDigest;
}

/// @notice The only two outcomes `validate` may return. Anything else reverts.
/// @dev APPROVED: all predicates pass, funds may move. HELD: all hard predicates
///      pass but a soft predicate failed — the account must NOT transfer funds; the
///      payment is parked for owner review.
enum Status {
    APPROVED,
    HELD
}
