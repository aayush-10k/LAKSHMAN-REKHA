// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PolicyModule} from "./PolicyModule.sol";
import {PaymentRequest, Status} from "./PaymentRequest.sol";

/// @title RekhaAccount — the fund-holding account
/// @notice Custodies INRx and is the ONLY path by which funds may leave. Every
///         outbound transfer is gated by {PolicyModule.validate}. There is no
///         owner backdoor: the owner can cancel a held payment but cannot move
///         money without a fully validated, dually-signed request.
/// @dev On APPROVED the account transfers and records the spend. On HELD it parks
///      the request for `holdWindowSeconds`; the owner may {cancelHold} it, or once
///      the window elapses anyone may {settleHold} it (subject to the still-live
///      hard guards: revocation, lease expiry, deadman freeze).
contract RekhaAccount is Ownable {
    using SafeERC20 for IERC20;

    // --------------------------------------------------------------------- //
    //                               Errors                                  //
    // --------------------------------------------------------------------- //

    error UnexpectedStatus();
    error NoSuchHold();
    error HoldNotActive();
    error HoldWindowNotElapsed();
    error HoldRevoked();
    error HoldLeaseExpired();

    // --------------------------------------------------------------------- //
    //                               Events                                  //
    // --------------------------------------------------------------------- //

    /// @notice Emitted when a payment actually moves funds (execute or settle).
    event PaymentExecuted(
        bytes32 indexed decisionId, address indexed counterparty, uint256 amountMinor
    );
    /// @notice Emitted when a soft-failed payment is parked. `softFailBitmask` marks
    ///         which of predicates 9/10/11 failed (see {PolicyModule.softFailBitmask}).
    event PaymentHeld(bytes32 indexed decisionId, uint16 softFailBitmask);
    /// @notice Emitted when the owner cancels a held payment.
    event HoldCancelled(bytes32 indexed decisionId);

    // --------------------------------------------------------------------- //
    //                                Types                                  //
    // --------------------------------------------------------------------- //

    /// @notice A parked (soft-failed) payment awaiting owner decision or timeout.
    struct Hold {
        address counterparty;
        uint256 amountMinor;
        uint64 nonce;
        uint64 revocationEpoch; // epoch the request was signed under
        uint64 leaseExpiry;
        uint64 holdUntil; // settleable at/after this timestamp
        bool active;
    }

    // --------------------------------------------------------------------- //
    //                               State                                   //
    // --------------------------------------------------------------------- //

    /// @notice The INRx token this account custodies.
    IERC20 public immutable token;
    /// @notice The policy authority every payment is validated against.
    PolicyModule public immutable policy;
    /// @notice How long a held payment waits before it becomes settleable.
    uint64 public immutable holdWindowSeconds;

    /// @notice Parked payments keyed by decision id.
    mapping(bytes32 => Hold) public holds;

    // --------------------------------------------------------------------- //
    //                            Construction                               //
    // --------------------------------------------------------------------- //

    /// @notice Deploys the account.
    /// @param initialOwner The business owner (may cancel holds; has no spend power).
    /// @param token_ The INRx token address.
    /// @param policy_ The PolicyModule address.
    /// @param holdWindowSeconds_ Seconds a hold waits before it can be settled.
    constructor(
        address initialOwner,
        IERC20 token_,
        PolicyModule policy_,
        uint64 holdWindowSeconds_
    ) Ownable(initialOwner) {
        token = token_;
        policy = policy_;
        holdWindowSeconds = holdWindowSeconds_;
    }

    // --------------------------------------------------------------------- //
    //                              Execution                                //
    // --------------------------------------------------------------------- //

    /// @notice Validates a payment and, on APPROVED, transfers funds; on HELD parks
    ///         it without transferring. Permissionless: safety comes entirely from
    ///         the dual-signature validation, not from the caller's identity.
    /// @dev Reverts (fails closed) on any hard predicate failure inside
    ///      {PolicyModule.validate}. The decision id is the request digest.
    /// @param req The payment request.
    /// @param agentSig Agent key-share signature.
    /// @param coreSig Core key-share signature.
    /// @return decisionId The identifier for this decision (also the request digest).
    function execute(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig)
        external
        returns (bytes32 decisionId)
    {
        decisionId = policy.hashRequest(req);

        Status status = policy.validate(req, agentSig, coreSig);

        if (status == Status.APPROVED) {
            _payout(decisionId, req.counterparty, req.amountMinor, req.nonce);
        } else if (status == Status.HELD) {
            holds[decisionId] = Hold({
                counterparty: req.counterparty,
                amountMinor: req.amountMinor,
                nonce: req.nonce,
                revocationEpoch: req.revocationEpoch,
                leaseExpiry: req.leaseExpiry,
                holdUntil: uint64(block.timestamp) + holdWindowSeconds,
                active: true
            });
            emit PaymentHeld(decisionId, policy.softFailBitmask(req));
        } else {
            // Unreachable: validate only ever returns APPROVED or HELD.
            revert UnexpectedStatus();
        }
    }

    /// @notice Owner cancels a parked payment. Funds never moved, so this simply
    ///         retires the hold.
    /// @param decisionId The hold to cancel.
    function cancelHold(bytes32 decisionId) external onlyOwner {
        Hold storage h = holds[decisionId];
        if (h.counterparty == address(0)) revert NoSuchHold();
        if (!h.active) revert HoldNotActive();
        h.active = false;
        emit HoldCancelled(decisionId);
    }

    /// @notice Executes a parked payment whose hold window elapsed without an owner
    ///         cancellation. Permissionless. Re-checks the still-live hard guards
    ///         (revocation epoch, lease expiry, deadman freeze via {recordSpend})
    ///         so a hold cannot be settled after the owner has revoked or the lease
    ///         has lapsed.
    /// @param decisionId The hold to settle.
    function settleHold(bytes32 decisionId) external {
        Hold storage h = holds[decisionId];
        if (h.counterparty == address(0)) revert NoSuchHold();
        if (!h.active) revert HoldNotActive();
        if (block.timestamp < h.holdUntil) revert HoldWindowNotElapsed();
        // Revocation raised since the hold was created invalidates it.
        if (h.revocationEpoch != policy.revocationEpoch()) revert HoldRevoked();
        // Lease that expired during the hold invalidates it.
        if (block.timestamp > h.leaseExpiry) revert HoldLeaseExpired();

        h.active = false;
        _payout(decisionId, h.counterparty, h.amountMinor, h.nonce);
    }

    // --------------------------------------------------------------------- //
    //                              Internals                                //
    // --------------------------------------------------------------------- //

    /// @dev Transfers funds and records the spend. `recordSpend` burns the nonce and
    ///      updates counters, reverting if the nonce is already used or a cap/guard
    ///      trips — so a settled hold that collides with a since-spent nonce fails
    ///      closed.
    function _payout(bytes32 decisionId, address counterparty, uint256 amountMinor, uint64 nonce)
        internal
    {
        policy.recordSpend(amountMinor, nonce);
        token.safeTransfer(counterparty, amountMinor);
        emit PaymentExecuted(decisionId, counterparty, amountMinor);
    }
}
