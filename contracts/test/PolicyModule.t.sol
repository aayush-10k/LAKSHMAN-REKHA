// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyModule, PolicyInit} from "../src/PolicyModule.sol";
import {PaymentRequest, Status} from "../src/PaymentRequest.sol";

/// @dev Exercises {PolicyModule.validate} one predicate at a time: a happy path
///      plus one test per named custom error, in the fixed evaluation order.
contract PolicyModuleTest is Test {
    PolicyModule internal policy;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");

    uint256 internal agentPk;
    uint256 internal corePk;
    address internal agentSigner;
    address internal coreSigner;

    address internal cp1 = makeAddr("tier1cp");
    address internal cp2 = makeAddr("tier2cp");
    address internal cp3 = makeAddr("tier3cp");

    bytes32 internal constant IMAGE = keccak256("approved-core-image-v1");

    // Caps chosen so each cap predicate can be triggered in isolation.
    uint256 internal constant PER_TX = 1_000_000; // ₹10,000
    uint256 internal constant WINDOW_CAP = 1_500_000;
    uint64 internal constant WINDOW_SECS = 1 days;
    uint256 internal constant CUMULATIVE_CAP = 1_500_000;
    uint256 internal constant TIER2_CAP = 500_000;
    uint8 internal constant CATEGORY = 7;

    function setUp() public {
        (agentSigner, agentPk) = makeAddrAndKey("agent");
        (coreSigner, corePk) = makeAddrAndKey("core");

        PolicyInit memory init = PolicyInit({
            owner: owner,
            guardian: guardian,
            agentSigner: agentSigner,
            coreSigner: coreSigner,
            coreImageDigest: IMAGE,
            perTxCapMinor: PER_TX,
            windowCapMinor: WINDOW_CAP,
            windowSeconds: WINDOW_SECS,
            cumulativeCapMinor: CUMULATIVE_CAP,
            permittedCategories: uint256(1) << CATEGORY,
            tier2MinAgeDays: 30,
            tier2MinSettledTxns: 5,
            tier2MaxPriceBandZ: 2,
            tier2CapMinor: TIER2_CAP,
            deadmanSeconds: 7 days
        });

        // Warp off zero so timestamps behave normally.
        vm.warp(1_000_000);
        policy = new PolicyModule(init);

        vm.startPrank(owner);
        policy.setCounterpartyTier(cp1, 1);
        policy.setCounterpartyTier(cp2, 2);
        policy.setCounterpartyTier(cp3, 3);
        policy.setAccount(address(this)); // this test acts as the account for recordSpend
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- //
    //                              Helpers                                //
    // ------------------------------------------------------------------- //

    /// @dev A fully-valid tier-1 request that approves cleanly.
    function _baseReq() internal view returns (PaymentRequest memory req) {
        req = PaymentRequest({
            amountMinor: 400_000,
            counterparty: cp1,
            counterpartyTier: 1,
            counterpartyAgeDays: 365,
            counterpartySettledTxns: 100,
            priceBandZ: 0,
            categoryCode: CATEGORY,
            leaseId: keccak256("lease-1"),
            nonce: 1,
            revocationEpoch: 0,
            leaseExpiry: uint64(block.timestamp + 1 days),
            coreImageDigest: IMAGE
        });
    }

    function _sign(uint256 pk, PaymentRequest memory req) internal view returns (bytes memory) {
        bytes32 digest = policy.hashRequest(req); // domain-separated digest from the contract
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sigs(PaymentRequest memory req)
        internal
        view
        returns (bytes memory a, bytes memory c)
    {
        a = _sign(agentPk, req);
        c = _sign(corePk, req);
    }

    // ------------------------------------------------------------------- //
    //                            Happy path                               //
    // ------------------------------------------------------------------- //

    function test_happyPath_approved() public view {
        PaymentRequest memory req = _baseReq();
        (bytes memory a, bytes memory c) = _sigs(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.APPROVED));
    }

    // ------------------------------------------------------------------- //
    //             One test per named custom error (1..14)                 //
    // ------------------------------------------------------------------- //

    function test_p1_invalidAgentSignature() public {
        PaymentRequest memory req = _baseReq();
        (, uint256 wrongPk) = makeAddrAndKey("not-agent");
        bytes memory a = _sign(wrongPk, req);
        bytes memory c = _sign(corePk, req);
        vm.expectRevert(PolicyModule.InvalidAgentSignature.selector);
        policy.validate(req, a, c);
    }

    function test_p2_invalidCoreSignature() public {
        PaymentRequest memory req = _baseReq();
        (, uint256 wrongPk) = makeAddrAndKey("not-core");
        bytes memory a = _sign(agentPk, req);
        bytes memory c = _sign(wrongPk, req);
        vm.expectRevert(PolicyModule.InvalidCoreSignature.selector);
        policy.validate(req, a, c);
    }

    function test_p3_coreImageMismatch_wrongImage() public {
        PaymentRequest memory req = _baseReq();
        req.coreImageDigest = keccak256("some-other-image"); // != registered IMAGE
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CoreImageMismatch.selector);
        policy.validate(req, a, c);
    }

    function test_p3_coreImageMismatch_afterRevoke() public {
        // Owner distrusts the core by clearing the registered image; a request
        // carrying the previously-approved image now mismatches (registered == 0).
        PaymentRequest memory req = _baseReq(); // req.coreImageDigest == IMAGE
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.prank(owner);
        policy.revokeCoreImage();
        vm.expectRevert(PolicyModule.CoreImageMismatch.selector);
        policy.validate(req, a, c);
    }

    function test_p4_staleRevocationEpoch() public {
        PaymentRequest memory req = _baseReq(); // revocationEpoch = 0
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.prank(guardian);
        policy.revoke(); // epoch -> 1
        vm.expectRevert(PolicyModule.StaleRevocationEpoch.selector);
        policy.validate(req, a, c);
    }

    function test_p5_leaseExpired() public {
        PaymentRequest memory req = _baseReq();
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.warp(req.leaseExpiry + 1);
        vm.expectRevert(PolicyModule.LeaseExpired.selector);
        policy.validate(req, a, c);
    }

    function test_p6_nonceAlreadyUsed() public {
        PaymentRequest memory req = _baseReq();
        (bytes memory a, bytes memory c) = _sigs(req);
        // Burn the nonce as the linked account.
        policy.recordSpend(req.amountMinor, req.nonce);
        vm.expectRevert(PolicyModule.NonceAlreadyUsed.selector);
        policy.validate(req, a, c);
    }

    function test_p7_categoryNotPermitted() public {
        PaymentRequest memory req = _baseReq();
        req.categoryCode = 3; // not set in the bitmap
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CategoryNotPermitted.selector);
        policy.validate(req, a, c);
    }

    function test_p8_counterpartyBlocked_tier3() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp3; // tier 3
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CounterpartyBlocked.selector);
        policy.validate(req, a, c);
    }

    function test_p8_counterpartyBlocked_unknownTier0() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = makeAddr("stranger"); // tier 0 unknown
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CounterpartyBlocked.selector);
        policy.validate(req, a, c);
    }

    function test_p8_counterpartyBlocked_tierMismatch() public {
        // Registry says cp1 is tier 1, but the request claims tier 2 -> blocked.
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp1; // registry tier 1
        req.counterpartyTier = 2; // disagrees with the registry
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CounterpartyBlocked.selector);
        policy.validate(req, a, c);
    }

    function test_p9_counterpartyTooNew_soft_held() public view {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.counterpartyAgeDays = 10; // < 30 -> soft fail
        (bytes memory a, bytes memory c) = _sigsView(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.HELD));
    }

    function test_p10_counterpartyUnproven_soft_held() public view {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.counterpartySettledTxns = 1; // < 5 -> soft fail
        (bytes memory a, bytes memory c) = _sigsView(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.HELD));
    }

    function test_p11_priceOutsideBand_soft_held() public view {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.priceBandZ = 3; // |3| > 2 -> soft fail
        (bytes memory a, bytes memory c) = _sigsView(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.HELD));
    }

    function test_p12_perTxCapExceeded() public {
        PaymentRequest memory req = _baseReq();
        req.amountMinor = PER_TX + 1;
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.PerTxCapExceeded.selector);
        policy.validate(req, a, c);
    }

    function test_p13_windowCapExceeded() public {
        // Pre-fill the window with a recorded spend, then validate another that
        // would push the window over its cap.
        policy.recordSpend(PER_TX, 99); // window = 1_000_000
        PaymentRequest memory req = _baseReq();
        req.amountMinor = PER_TX; // 1_000_000 + 1_000_000 = 2M > 1.5M window cap
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.WindowCapExceeded.selector);
        policy.validate(req, a, c);
    }

    function test_p14_cumulativeCapExceeded() public {
        // Record a spend, then roll the window forward so the WINDOW check passes
        // but the CUMULATIVE counter still trips.
        policy.recordSpend(PER_TX, 99); // cumulative = 1_000_000, window = 1_000_000
        vm.warp(block.timestamp + WINDOW_SECS + 1); // window rolls to 0
        PaymentRequest memory req = _baseReq();
        req.amountMinor = 600_000; // window 0+0.6M ok; cumulative 1.0M+0.6M = 1.6M > 1.5M
        req.leaseExpiry = uint64(block.timestamp + 1 days);
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.CumulativeCapExceeded.selector);
        policy.validate(req, a, c);
    }

    // ------------------------------------------------------------------- //
    //                     Tier branching sanity checks                    //
    // ------------------------------------------------------------------- //

    function test_tier1_skipsSoftPredicates() public view {
        // Tier-1 counterparty with values that WOULD trip every soft predicate.
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp1;
        req.counterpartyAgeDays = 0;
        req.counterpartySettledTxns = 0;
        req.priceBandZ = 127;
        (bytes memory a, bytes memory c) = _sigsView(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.APPROVED));
    }

    function test_tier2_allSoftPass_approved() public view {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.amountMinor = 400_000; // < tier2 cap
        req.counterpartyAgeDays = 100;
        req.counterpartySettledTxns = 50;
        req.priceBandZ = 1;
        (bytes memory a, bytes memory c) = _sigsView(req);
        assertEq(uint256(policy.validate(req, a, c)), uint256(Status.APPROVED));
    }

    function test_tier2_perTxCapExceeded_usesTighterCap() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.amountMinor = TIER2_CAP + 1; // still < global PER_TX, but > tier-2 cap
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.expectRevert(PolicyModule.PerTxCapExceeded.selector);
        policy.validate(req, a, c);
    }

    // pure-context sig helper for `view` tests
    function _sigsView(PaymentRequest memory req)
        internal
        view
        returns (bytes memory a, bytes memory c)
    {
        a = _sign(agentPk, req);
        c = _sign(corePk, req);
    }

    // ------------------------------------------------------------------- //
    //          The guardian: can revoke, cannot do anything else          //
    // ------------------------------------------------------------------- //
    //
    // HONESTY_PLAN.md 3.2. BUILD.md:787 claims "guardian can revoke but cannot
    // spend" and only the CAN half was ever exercised (test_p4 pranks the
    // guardian through revoke()). The negative half was true by construction —
    // every other state-changing function is onlyOwner — but true by
    // construction is not the same as tested, and an untested half-claim on a
    // slide is exactly what HONESTY_PLAN exists to catch.
    //
    // These are cheap, and they are the difference between "we reasoned about
    // it" and "we checked".

    /// @dev The half that was already true: the guardian may raise the epoch.
    function test_guardian_canRevoke() public {
        uint64 before = policy.revocationEpoch();
        vm.prank(guardian);
        policy.revoke();
        assertEq(policy.revocationEpoch(), before + 1, "guardian must be able to revoke");
    }

    /// @dev And nothing else. Each of these is `onlyOwner`; a guardian that
    ///      could reach any one of them could re-point the signers, lift the
    ///      caps, or attest a core image of its choosing — which would make
    ///      "cannot spend" false by a longer route than signing.
    function test_guardian_cannotChangePolicy() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.setPolicy(
            PER_TX, WINDOW_CAP, WINDOW_SECS, CUMULATIVE_CAP,
            uint256(1) << CATEGORY, 30, 5, 2, TIER2_CAP
        );
    }

    function test_guardian_cannotRepointSigners() public {
        // The sharpest one. Repointing the core signer to a key the guardian
        // holds would hand it the second signature outright.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.setSigners(guardian, guardian);
    }

    function test_guardian_cannotMoveTheAccount() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.setAccount(guardian);
    }

    function test_guardian_cannotAttestACoreImage() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.attestCoreImage(keccak256("a core the guardian wrote"));
    }

    function test_guardian_cannotPromoteACounterparty() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.setCounterpartyTier(guardian, 1);
    }

    function test_guardian_cannotHeartbeat() public {
        // Keeping the dead-man switch alive is an owner responsibility. A
        // guardian that could heartbeat could hold a lapsed mandate open.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", guardian));
        policy.heartbeat();
    }

    /// @dev The claim itself, end to end: a payment naming the guardian as both
    ///      signer and payee does not validate. The guardian holds neither key,
    ///      so `ECDSA.recover` returns its address and predicate 1 refuses.
    function test_guardian_cannotSpend() public {
        (address guardianAddr, uint256 guardianPk) = makeAddrAndKey("guardian");
        assertEq(guardianAddr, guardian, "fixture drift: guardian key must match the init address");

        PaymentRequest memory req = _baseReq();
        req.counterparty = guardian; // pay itself

        bytes memory a = _sign(guardianPk, req);
        bytes memory c = _sign(guardianPk, req);

        // Dies at predicate 1. It never even reaches the counterparty checks —
        // which is the point: the guardian is not a signer, and no amount of
        // being a guardian makes it one.
        vm.expectRevert(PolicyModule.InvalidAgentSignature.selector);
        policy.validate(req, a, c);
    }

    /// @dev And it cannot borrow the agent's half either. Holding one real
    ///      signature plus its own is the strongest position a guardian could
    ///      reach, and it is still short.
    function test_guardian_cannotSpend_evenWithTheAgentsSignature() public {
        (, uint256 guardianPk) = makeAddrAndKey("guardian");

        PaymentRequest memory req = _baseReq();
        req.counterparty = guardian;

        bytes memory a = _sign(agentPk, req); // a genuine agent signature
        bytes memory c = _sign(guardianPk, req); // the guardian standing in for the core

        vm.expectRevert(PolicyModule.InvalidCoreSignature.selector);
        policy.validate(req, a, c);
    }
}
