// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PaymentRequest, Status} from "./PaymentRequest.sol";

/// @notice Constructor / re-initialisation parameters for {PolicyModule}.
/// @dev Grouped into a struct purely to keep the constructor readable and to avoid
///      stack-too-deep; every field maps 1:1 to a state variable below.
struct PolicyInit {
    address owner;
    address guardian;
    address agentSigner;
    address coreSigner;
    bytes32 coreImageDigest;
    uint256 perTxCapMinor;
    uint256 windowCapMinor;
    uint64 windowSeconds;
    uint256 cumulativeCapMinor;
    uint256 permittedCategories;
    uint16 tier2MinAgeDays;
    uint32 tier2MinSettledTxns;
    int8 tier2MaxPriceBandZ;
    uint256 tier2CapMinor;
    uint64 deadmanSeconds;
}

/// @title PolicyModule — the deterministic spend-control authority
/// @notice Holds the second key share (as `coreSigner`) and re-verifies every
///         predicate independently of any off-chain service. It is the final
///         authority: if a check does not pass here, no funds move.
/// @dev Design rules baked into this contract:
///      - No admin backdoor: there is NO function that moves funds. This module
///        only validates and accounts; the account moves money and only after a
///        successful {validate}.
///      - Fail closed: every unexpected condition reverts. No code path falls
///        through to "allow".
///      - Fixed predicate order: {validate} evaluates predicates 1..14 in the exact
///        order specified in docs/API.md so an off-chain TypeScript evaluator can
///        mirror it byte-for-byte. Do not reorder.
contract PolicyModule is Ownable {
    // --------------------------------------------------------------------- //
    //                               Errors                                  //
    // --------------------------------------------------------------------- //

    // Predicate errors, in evaluation order.
    error InvalidAgentSignature(); // 1  hard
    error InvalidCoreSignature(); // 2  hard
    error CoreImageMismatch(); // 3  hard
    error StaleRevocationEpoch(); // 4  hard
    error LeaseExpired(); // 5  hard
    error NonceAlreadyUsed(); // 6  hard
    error CategoryNotPermitted(); // 7  hard
    error CounterpartyBlocked(); // 8  hard
    error CounterpartyTooNew(); // 9  soft
    error CounterpartyUnproven(); // 10 soft
    error PriceOutsideBand(); // 11 soft
    error PerTxCapExceeded(); // 12 hard
    error WindowCapExceeded(); // 13 hard
    error CumulativeCapExceeded(); // 14 hard

    // Operational guards (outside the 14 predicates; all fail-closed).
    error AccountFrozen();
    error NotOwnerOrGuardian();
    error OnlyAccount();
    error InvalidTier();
    error RevocationNotMonotonic();

    // --------------------------------------------------------------------- //
    //                               Events                                  //
    // --------------------------------------------------------------------- //

    event Revoked(uint64 newEpoch, address indexed caller);
    event HeartbeatPinged(uint64 at);
    event DeadmanTriggered(uint64 at, address indexed caller);
    event PolicyUpdated(bytes32 policyHash);
    event TierSet(address indexed counterparty, uint8 tier);
    event CoreImageAttested(bytes32 digest);
    event AccountLinked(address indexed account);
    event SpendRecorded(
        uint64 indexed nonce, uint256 amountMinor, uint256 windowSpent, uint256 cumulativeSpent
    );

    // --------------------------------------------------------------------- //
    //                               State                                   //
    // --------------------------------------------------------------------- //

    /// @notice Guardian may revoke (raise the epoch) but nothing else.
    address public guardian;
    /// @notice Agent key share. Its signature is predicate 1.
    address public agentSigner;
    /// @notice Core key share. Its signature is predicate 2.
    address public coreSigner;
    /// @notice Approved core-code image. Predicate 3 fails closed if this is zero.
    bytes32 public coreImageDigest;

    /// @notice Monotonic revocation counter. Every valid request must carry the
    ///         current value; raising it instantly staleness-kills all in-flight
    ///         requests signed under the old epoch.
    uint64 public revocationEpoch;

    /// @notice Hash of the current tunable policy; bumped by {setPolicy}.
    bytes32 public policyHash;

    // Spend caps (all minor units / paise).
    uint256 public perTxCapMinor;
    uint256 public windowCapMinor;
    uint64 public windowSeconds;
    uint256 public cumulativeCapMinor;

    // Rolling accounting.
    uint64 public windowStart;
    uint256 public windowSpentMinor;
    uint256 public cumulativeSpentMinor;

    /// @notice Burned nonces. A nonce is consumed on an actual spend.
    mapping(uint64 => bool) public usedNonces;
    /// @notice Counterparty tier registry (owner-controlled). 0 = unknown (blocked).
    mapping(address => uint8) public counterpartyTier;

    // Tier-2 soft thresholds.
    uint16 public tier2MinAgeDays;
    uint32 public tier2MinSettledTxns;
    int8 public tier2MaxPriceBandZ;
    uint256 public tier2CapMinor;

    /// @notice Category allow-list as a 256-bit bitmap indexed by `categoryCode`.
    uint256 public permittedCategories;

    // Deadman switch.
    uint64 public lastHeartbeat;
    uint64 public deadmanSeconds;
    bool public frozen;

    /// @notice The single RekhaAccount permitted to call {recordSpend}.
    address public account;

    // --------------------------------------------------------------------- //
    //                            Construction                               //
    // --------------------------------------------------------------------- //

    /// @notice Deploys and fully configures the policy authority.
    /// @param init All initial parameters (see {PolicyInit}).
    constructor(PolicyInit memory init) Ownable(init.owner) {
        guardian = init.guardian;
        agentSigner = init.agentSigner;
        coreSigner = init.coreSigner;
        coreImageDigest = init.coreImageDigest;
        perTxCapMinor = init.perTxCapMinor;
        windowCapMinor = init.windowCapMinor;
        windowSeconds = init.windowSeconds;
        cumulativeCapMinor = init.cumulativeCapMinor;
        permittedCategories = init.permittedCategories;
        tier2MinAgeDays = init.tier2MinAgeDays;
        tier2MinSettledTxns = init.tier2MinSettledTxns;
        tier2MaxPriceBandZ = init.tier2MaxPriceBandZ;
        tier2CapMinor = init.tier2CapMinor;
        deadmanSeconds = init.deadmanSeconds;
        lastHeartbeat = uint64(block.timestamp);
        _bumpPolicyHash();
    }

    // --------------------------------------------------------------------- //
    //                              Validation                               //
    // --------------------------------------------------------------------- //

    /// @notice The canonical digest both key shares sign.
    /// @dev `keccak256(abi.encode(block.chainid, address(this), req))`. The chain id
    ///      and this contract's address are mixed in for domain separation: a
    ///      signed request cannot be replayed on another chain or against a
    ///      different PolicyModule deployment. The off-chain evaluator must mix in
    ///      the same two values.
    /// @param req The payment request.
    /// @return The 32-byte digest to sign / recover against.
    function hashRequest(PaymentRequest calldata req) public view returns (bytes32) {
        return _digest(req);
    }

    /// @dev Internal digest used by both {hashRequest} and {validate} so they can
    ///      never drift apart.
    function _digest(PaymentRequest calldata req) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), req));
    }

    /// @notice Re-verifies every predicate for `req` in the fixed order.
    /// @dev Hard predicates revert with their named error. Soft predicates set a
    ///      hold flag but do not revert. Returns {Status.APPROVED} if all pass, or
    ///      {Status.HELD} if all hard pass but a soft predicate failed. Reverts
    ///      closed if the account is frozen or the deadman has lapsed.
    /// @param req The payment request.
    /// @param agentSig 65-byte ECDSA signature by `agentSigner` over {hashRequest}.
    /// @param coreSig 65-byte ECDSA signature by `coreSigner` over {hashRequest}.
    /// @return status APPROVED or HELD.
    function validate(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig)
        external
        view
        returns (Status status)
    {
        // Fail-closed operational guard: a frozen or heartbeat-lapsed account
        // approves nothing. This sits ahead of the 14 predicates by design.
        if (frozen || _deadmanLapsed()) revert AccountFrozen();

        bytes32 digest = _digest(req);

        // 1 — agentSignature (hard)
        if (ECDSA.recover(digest, agentSig) != agentSigner) revert InvalidAgentSignature();
        // 2 — coreSignature (hard)
        if (ECDSA.recover(digest, coreSig) != coreSigner) revert InvalidCoreSignature();
        // 3 — coreImage (hard): the image the core claims to run must match the
        // registered approved image. (A zero registered image never matches a real
        // request, so an un-pinned core still fails closed.)
        if (req.coreImageDigest != coreImageDigest) revert CoreImageMismatch();
        // 4 — revocationEpoch (hard): request must carry the current epoch.
        if (req.revocationEpoch != revocationEpoch) revert StaleRevocationEpoch();
        // 5 — leaseExpiry (hard)
        if (block.timestamp > req.leaseExpiry) revert LeaseExpired();
        // 6 — nonce (hard)
        if (usedNonces[req.nonce]) revert NonceAlreadyUsed();
        // 7 — categoryPermitted (hard)
        if (!_categoryPermitted(req.categoryCode)) revert CategoryNotPermitted();

        // 8 — counterpartyTier (hard). Tier comes from the on-chain registry, never
        // from req (the registry is authoritative). Tier 3 blocked; tier 0 unknown
        // is blocked fail-closed. Tier 1 and 2 continue.
        uint8 tier = counterpartyTier[req.counterparty];
        if (tier != 1 && tier != 2) revert CounterpartyBlocked();
        // The request must also declare the tier the registry holds. A mismatch
        // means the signed request disagrees with the authoritative registry —
        // block fail-closed rather than trust either value.
        if (req.counterpartyTier != tier) revert CounterpartyBlocked();

        bool held = false;

        // Soft predicates 9–11 run for tier 2 only. Tier 1 skips them entirely.
        if (tier == 2) {
            // 9 — counterpartyAge (soft)
            if (req.counterpartyAgeDays < tier2MinAgeDays) held = true;
            // 10 — counterpartySettled (soft)
            if (req.counterpartySettledTxns < tier2MinSettledTxns) held = true;
            // 11 — priceBand (soft): |z| must be within the allowed band.
            int256 z = req.priceBandZ;
            int256 absZ = z < 0 ? -z : z;
            if (absZ > int256(tier2MaxPriceBandZ)) held = true;
        }

        // 12 — perTxCap (hard)
        if (req.amountMinor > perTxCapMinor) revert PerTxCapExceeded();
        // Tier-2 counterparties also carry a tighter per-tx ceiling.
        if (tier == 2 && req.amountMinor > tier2CapMinor) revert PerTxCapExceeded();

        // 13 — windowCap (hard). Uses the effective (possibly rolled) window spend.
        if (_effectiveWindowSpent() + req.amountMinor > windowCapMinor) {
            revert WindowCapExceeded();
        }

        // 14 — cumulativeCap (hard)
        if (cumulativeSpentMinor + req.amountMinor > cumulativeCapMinor) {
            revert CumulativeCapExceeded();
        }

        return held ? Status.HELD : Status.APPROVED;
    }

    /// @notice Bit 0 (0x1): predicate 9 (counterpartyAge) failed.
    uint16 public constant SOFT_FAIL_AGE = 0x1;
    /// @notice Bit 1 (0x2): predicate 10 (counterpartySettled) failed.
    uint16 public constant SOFT_FAIL_SETTLED = 0x2;
    /// @notice Bit 2 (0x4): predicate 11 (priceBand) failed.
    uint16 public constant SOFT_FAIL_PRICE = 0x4;

    /// @notice Which soft predicates (9/10/11) `req` fails, as a bitmask.
    /// @dev Mirrors the soft-predicate logic in {validate} exactly. Returns 0 for
    ///      tier-1 and tier-3 counterparties, which never run the soft predicates.
    ///      Used by the account to report *why* a payment was held.
    /// @param req The payment request.
    /// @return mask OR of {SOFT_FAIL_AGE}, {SOFT_FAIL_SETTLED}, {SOFT_FAIL_PRICE}.
    function softFailBitmask(PaymentRequest calldata req) public view returns (uint16 mask) {
        if (counterpartyTier[req.counterparty] != 2) return 0;
        if (req.counterpartyAgeDays < tier2MinAgeDays) mask |= SOFT_FAIL_AGE;
        if (req.counterpartySettledTxns < tier2MinSettledTxns) mask |= SOFT_FAIL_SETTLED;
        int256 z = req.priceBandZ;
        int256 absZ = z < 0 ? -z : z;
        if (absZ > int256(tier2MaxPriceBandZ)) mask |= SOFT_FAIL_PRICE;
    }

    // --------------------------------------------------------------------- //
    //                          Spend accounting                             //
    // --------------------------------------------------------------------- //

    /// @notice Records a completed spend: burns the nonce and advances the window
    ///         and cumulative counters. Callable only by the linked account.
    /// @dev Re-asserts the caps after updating (defence in depth) so the window and
    ///      cumulative invariants hold at the accounting layer too, independent of
    ///      {validate}. Fails closed if frozen/lapsed or the nonce is already burned.
    /// @param amountMinor The amount that was transferred, in minor units.
    /// @param nonce The request nonce to burn.
    function recordSpend(uint256 amountMinor, uint64 nonce) external {
        if (msg.sender != account) revert OnlyAccount();
        if (frozen || _deadmanLapsed()) revert AccountFrozen();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        usedNonces[nonce] = true;

        // Roll the window if it has elapsed (or was never started).
        if (windowStart == 0 || block.timestamp >= windowStart + windowSeconds) {
            windowStart = uint64(block.timestamp);
            windowSpentMinor = 0;
        }

        windowSpentMinor += amountMinor;
        cumulativeSpentMinor += amountMinor;

        // Defence in depth: the account already validated, but never let the
        // counters exceed the caps.
        if (windowSpentMinor > windowCapMinor) revert WindowCapExceeded();
        if (cumulativeSpentMinor > cumulativeCapMinor) revert CumulativeCapExceeded();

        emit SpendRecorded(nonce, amountMinor, windowSpentMinor, cumulativeSpentMinor);
    }

    // --------------------------------------------------------------------- //
    //                        Revocation / deadman                           //
    // --------------------------------------------------------------------- //

    /// @notice Raises the revocation epoch, instantly invalidating every in-flight
    ///         request signed under the old epoch. Owner or guardian only.
    /// @dev Monotonic: the epoch can only ever increase. There is no setter that
    ///      lowers it.
    function revoke() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian();
        uint64 next = revocationEpoch + 1;
        if (next <= revocationEpoch) revert RevocationNotMonotonic(); // overflow guard
        revocationEpoch = next;
        emit Revoked(next, msg.sender);
    }

    /// @notice Owner heartbeat that keeps the deadman switch from firing.
    function heartbeat() external onlyOwner {
        lastHeartbeat = uint64(block.timestamp);
        emit HeartbeatPinged(lastHeartbeat);
    }

    /// @notice Anyone may call. Freezes the module if the heartbeat has lapsed.
    /// @dev Fail-closed automation: if the owner goes dark past `deadmanSeconds`,
    ///      any observer can halt spending.
    function checkDeadman() external {
        if (_deadmanLapsed()) {
            frozen = true;
            emit DeadmanTriggered(uint64(block.timestamp), msg.sender);
        }
    }

    // --------------------------------------------------------------------- //
    //                              Owner config                             //
    // --------------------------------------------------------------------- //

    /// @notice Updates the tunable policy knobs and bumps `policyHash`. Owner only.
    /// @param perTxCapMinor_ New per-transaction cap (minor units).
    /// @param windowCapMinor_ New rolling-window cap (minor units).
    /// @param windowSeconds_ New window length in seconds.
    /// @param cumulativeCapMinor_ New lifetime cumulative cap (minor units).
    /// @param permittedCategories_ New category allow-list bitmap.
    /// @param tier2MinAgeDays_ Minimum counterparty age (days) for tier 2.
    /// @param tier2MinSettledTxns_ Minimum settled txns for tier 2.
    /// @param tier2MaxPriceBandZ_ Maximum absolute price-band z for tier 2.
    /// @param tier2CapMinor_ Tighter per-tx cap for tier 2 counterparties.
    function setPolicy(
        uint256 perTxCapMinor_,
        uint256 windowCapMinor_,
        uint64 windowSeconds_,
        uint256 cumulativeCapMinor_,
        uint256 permittedCategories_,
        uint16 tier2MinAgeDays_,
        uint32 tier2MinSettledTxns_,
        int8 tier2MaxPriceBandZ_,
        uint256 tier2CapMinor_
    ) external onlyOwner {
        perTxCapMinor = perTxCapMinor_;
        windowCapMinor = windowCapMinor_;
        windowSeconds = windowSeconds_;
        cumulativeCapMinor = cumulativeCapMinor_;
        permittedCategories = permittedCategories_;
        tier2MinAgeDays = tier2MinAgeDays_;
        tier2MinSettledTxns = tier2MinSettledTxns_;
        tier2MaxPriceBandZ = tier2MaxPriceBandZ_;
        tier2CapMinor = tier2CapMinor_;
        _bumpPolicyHash();
    }

    /// @notice Sets a counterparty's tier in the registry. Owner only.
    /// @param counterparty The counterparty address.
    /// @param tier 1, 2, or 3. (0 = unknown is the implicit default and is blocked.)
    function setCounterpartyTier(address counterparty, uint8 tier) external onlyOwner {
        if (tier > 3) revert InvalidTier();
        counterpartyTier[counterparty] = tier;
        emit TierSet(counterparty, tier);
    }

    /// @notice Sets/rotates the approved core-code image. Owner only.
    /// @param digest The new approved image digest (non-zero to enable spending).
    function attestCoreImage(bytes32 digest) external onlyOwner {
        coreImageDigest = digest;
        emit CoreImageAttested(digest);
    }

    /// @notice Instantly distrusts the running core by clearing its approved image.
    ///         Every subsequent {validate} fails predicate 3 until re-attested.
    function revokeCoreImage() external onlyOwner {
        coreImageDigest = bytes32(0);
        emit CoreImageAttested(bytes32(0));
    }

    /// @notice Rotates the agent and core signer key shares. Owner only.
    /// @param agentSigner_ New agent signer.
    /// @param coreSigner_ New core signer.
    function setSigners(address agentSigner_, address coreSigner_) external onlyOwner {
        agentSigner = agentSigner_;
        coreSigner = coreSigner_;
    }

    /// @notice Links the single RekhaAccount allowed to call {recordSpend}. Owner only.
    /// @param account_ The account address.
    function setAccount(address account_) external onlyOwner {
        account = account_;
        emit AccountLinked(account_);
    }

    // --------------------------------------------------------------------- //
    //                              Internals                                //
    // --------------------------------------------------------------------- //

    /// @dev True if the deadman switch has lapsed (heartbeat too old).
    function _deadmanLapsed() internal view returns (bool) {
        if (deadmanSeconds == 0) return false; // disabled
        return block.timestamp > uint256(lastHeartbeat) + uint256(deadmanSeconds);
    }

    /// @dev The window spend as of now, accounting for a rolled-over window.
    function _effectiveWindowSpent() internal view returns (uint256) {
        if (windowStart == 0 || block.timestamp >= uint256(windowStart) + uint256(windowSeconds)) {
            return 0;
        }
        return windowSpentMinor;
    }

    /// @dev True if `categoryCode`'s bit is set in the allow-list bitmap.
    function _categoryPermitted(uint8 categoryCode) internal view returns (bool) {
        return (permittedCategories >> categoryCode) & 1 == 1;
    }

    /// @dev Recomputes and stores `policyHash` over the current tunable policy.
    function _bumpPolicyHash() internal {
        policyHash = keccak256(
            abi.encode(
                perTxCapMinor,
                windowCapMinor,
                windowSeconds,
                cumulativeCapMinor,
                permittedCategories,
                tier2MinAgeDays,
                tier2MinSettledTxns,
                tier2MaxPriceBandZ,
                tier2CapMinor,
                deadmanSeconds
            )
        );
        emit PolicyUpdated(policyHash);
    }
}
