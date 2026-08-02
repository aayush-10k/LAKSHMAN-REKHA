// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {INRx} from "../src/INRx.sol";
import {PolicyModule, PolicyInit} from "../src/PolicyModule.sol";
import {RekhaAccount} from "../src/RekhaAccount.sol";
import {PaymentRequest, Status} from "../src/PaymentRequest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives the system with a mix of valid and adversarial calls so the
///         invariants below are meaningfully exercised. Every attempted call is
///         wrapped in try/catch: the contracts must reject bad calls WITHOUT moving
///         funds, and the handler records a violation flag if any bad call leaks a
///         transfer.
contract InvariantHandler is Test {
    INRx internal token;
    PolicyModule internal policy;
    RekhaAccount internal account;

    uint256 internal agentPk;
    uint256 internal corePk;

    address internal guardianAddr;
    address internal cp1; // tier 1
    address internal cp2; // tier 2
    address internal cp3; // tier 3

    uint8 internal constant CATEGORY = 7;
    uint256 internal immutable PER_TX;

    // Ghost state for the invariants.
    mapping(uint64 => bool) internal burnedNonceGhost;
    bool public doubleNonceObserved; // INV5 violation
    bool public staleEpochLeaked; // INV2 violation
    bool public badSigLeaked; // INV3 violation
    bool public blockedCpLeaked; // INV4 violation
    uint256 public totalTransferred;

    constructor(
        INRx token_,
        PolicyModule policy_,
        RekhaAccount account_,
        uint256 agentPk_,
        uint256 corePk_,
        address guardian_,
        address cp1_,
        address cp2_,
        address cp3_,
        uint256 perTx_
    ) {
        token = token_;
        policy = policy_;
        account = account_;
        agentPk = agentPk_;
        corePk = corePk_;
        guardianAddr = guardian_;
        cp1 = cp1_;
        cp2 = cp2_;
        cp3 = cp3_;
        PER_TX = perTx_;
    }

    function _req(address cp, uint256 amount, uint64 nonce, uint64 epoch)
        internal
        view
        returns (PaymentRequest memory req)
    {
        req = PaymentRequest({
            amountMinor: amount,
            counterparty: cp,
            counterpartyTier: 1,
            counterpartyAgeDays: 365,
            counterpartySettledTxns: 100,
            priceBandZ: 0,
            categoryCode: CATEGORY,
            leaseId: keccak256(abi.encode("lease", nonce)),
            nonce: nonce,
            revocationEpoch: epoch,
            leaseExpiry: uint64(block.timestamp + 365 days),
            coreImageDigest: keccak256("img") // matches the policy's registered image
        });
    }

    function _sign(uint256 pk, PaymentRequest memory req) internal view returns (bytes memory) {
        bytes32 digest = policy.hashRequest(req); // domain-separated digest from the contract
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- Valid path: fully-signed, in-epoch, permitted tier-1 request. Small nonce
    // space so nonce reuse is attempted frequently (exercises INV5). ---
    function doValid(uint256 seed) external {
        uint64 nonce = uint64(bound(seed, 1, 30));
        uint256 amount = bound(seed, 1, PER_TX);
        PaymentRequest memory req = _req(cp1, amount, nonce, policy.revocationEpoch());
        bytes memory a = _sign(agentPk, req);
        bytes memory c = _sign(corePk, req);

        uint256 before = token.balanceOf(address(account));
        try account.execute(req, a, c) {
            uint256 afterBal = token.balanceOf(address(account));
            if (afterBal < before) {
                if (burnedNonceGhost[nonce]) doubleNonceObserved = true;
                burnedNonceGhost[nonce] = true;
                totalTransferred += (before - afterBal);
            }
        } catch {}
    }

    // --- Adversarial: wrong revocation epoch. Must revert, never transfer. ---
    function doStaleEpoch(uint256 seed) external {
        uint64 nonce = uint64(bound(seed, 100, 130));
        PaymentRequest memory req = _req(cp1, 1, nonce, policy.revocationEpoch() + 1);
        bytes memory a = _sign(agentPk, req);
        bytes memory c = _sign(corePk, req);

        uint256 cpBefore = token.balanceOf(cp1);
        try account.execute(req, a, c) {} catch {}
        if (token.balanceOf(cp1) > cpBefore) staleEpochLeaked = true;
    }

    // --- Adversarial: garbage signatures. Must revert, never transfer. ---
    function doBadSig(uint256 seed) external {
        uint64 nonce = uint64(bound(seed, 200, 230));
        PaymentRequest memory req = _req(cp1, 1, nonce, policy.revocationEpoch());
        bytes memory bad = abi.encodePacked(bytes32(seed), bytes32(uint256(seed) + 1), uint8(27));

        uint256 cpBefore = token.balanceOf(cp1);
        try account.execute(req, bad, bad) {} catch {}
        if (token.balanceOf(cp1) > cpBefore) badSigLeaked = true;
    }

    // --- Adversarial: tier-3 (blocked) counterparty. Must revert, never transfer. ---
    function doBlockedCounterparty(uint256 seed) external {
        uint64 nonce = uint64(bound(seed, 300, 330));
        PaymentRequest memory req = _req(cp3, 1, nonce, policy.revocationEpoch());
        bytes memory a = _sign(agentPk, req);
        bytes memory c = _sign(corePk, req);

        uint256 cpBefore = token.balanceOf(cp3);
        try account.execute(req, a, c) {} catch {}
        if (token.balanceOf(cp3) > cpBefore) blockedCpLeaked = true;
    }

    function doRevoke() external {
        // Advance the revocation epoch via the guardian to churn state during the run.
        vm.prank(guardianAddr);
        policy.revoke();
    }

    function doWarp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }
}

/// @notice INV1..INV5 from CLAUDE.md.
contract InvariantsTest is Test {
    INRx internal token;
    PolicyModule internal policy;
    RekhaAccount internal account;
    InvariantHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");

    uint256 internal agentPk;
    uint256 internal corePk;
    address internal agentSigner;
    address internal coreSigner;

    address internal cp1 = makeAddr("tier1cp");
    address internal cp2 = makeAddr("tier2cp");
    address internal cp3 = makeAddr("tier3cp");

    uint256 internal constant PER_TX = 500_000;
    uint256 internal constant WINDOW_CAP = 2_000_000;
    uint256 internal constant CUMULATIVE_CAP = 1_000_000_000_000;
    uint256 internal constant FUNDING = 1_000_000_000_000;

    function setUp() public {
        (agentSigner, agentPk) = makeAddrAndKey("agent");
        (coreSigner, corePk) = makeAddrAndKey("core");

        vm.warp(1_000_000);

        PolicyInit memory init = PolicyInit({
            owner: owner,
            guardian: guardian,
            agentSigner: agentSigner,
            coreSigner: coreSigner,
            coreImageDigest: keccak256("img"),
            perTxCapMinor: PER_TX,
            windowCapMinor: WINDOW_CAP,
            windowSeconds: 1 days,
            cumulativeCapMinor: CUMULATIVE_CAP,
            permittedCategories: uint256(1) << 7,
            tier2MinAgeDays: 30,
            tier2MinSettledTxns: 5,
            tier2MaxPriceBandZ: 2,
            tier2CapMinor: PER_TX,
            deadmanSeconds: 3650 days // long: deadman is not the subject here
        });

        policy = new PolicyModule(init);
        token = new INRx(owner);
        account = new RekhaAccount(owner, IERC20(address(token)), policy, 1 days);

        vm.startPrank(owner);
        policy.setCounterpartyTier(cp1, 1);
        policy.setCounterpartyTier(cp2, 2);
        policy.setCounterpartyTier(cp3, 3);
        policy.setAccount(address(account));
        token.mint(address(account), FUNDING);
        vm.stopPrank();

        handler = new InvariantHandler(
            token, policy, account, agentPk, corePk, guardian, cp1, cp2, cp3, PER_TX
        );

        targetContract(address(handler));
    }

    /// @notice INV1: window outflow never exceeds the window cap (enforced by the
    ///         accounting layer, which caps `windowSpentMinor` at `windowCapMinor`).
    function invariant_INV1_windowNeverExceedsCap() public view {
        assertLe(policy.windowSpentMinor(), policy.windowCapMinor());
        assertLe(policy.cumulativeSpentMinor(), policy.cumulativeCapMinor());
    }

    /// @notice INV2: no transfer ever succeeded under a stale revocation epoch.
    function invariant_INV2_noStaleEpochTransfer() public view {
        assertFalse(handler.staleEpochLeaked());
    }

    /// @notice INV3: no transfer ever succeeded without both valid signatures.
    function invariant_INV3_noBadSigTransfer() public view {
        assertFalse(handler.badSigLeaked());
    }

    /// @notice INV4: no transfer ever succeeded to a counterparty failing its tier.
    function invariant_INV4_noBlockedCounterpartyTransfer() public view {
        assertFalse(handler.blockedCpLeaked());
    }

    /// @notice INV5: no nonce was ever consumed twice (no double-spend transfer).
    function invariant_INV5_noNonceConsumedTwice() public view {
        assertFalse(handler.doubleNonceObserved());
    }

    /// @notice Bonus: value is conserved — nothing is minted or burned by spending.
    function invariant_valueConservation() public view {
        uint256 out = token.balanceOf(cp1) + token.balanceOf(cp2) + token.balanceOf(cp3);
        assertEq(token.balanceOf(address(account)) + out, FUNDING);
    }
}
