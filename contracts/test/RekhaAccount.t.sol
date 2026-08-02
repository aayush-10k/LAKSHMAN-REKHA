// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {INRx} from "../src/INRx.sol";
import {PolicyModule, PolicyInit} from "../src/PolicyModule.sol";
import {RekhaAccount} from "../src/RekhaAccount.sol";
import {PaymentRequest, Status} from "../src/PaymentRequest.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Shared deployment + helpers for the account/integration tests.
abstract contract RekhaTestBase is Test {
    INRx internal token;
    PolicyModule internal policy;
    RekhaAccount internal account;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal relayer = makeAddr("relayer");

    uint256 internal agentPk;
    uint256 internal corePk;
    address internal agentSigner;
    address internal coreSigner;

    address internal cp1 = makeAddr("tier1cp");
    address internal cp2 = makeAddr("tier2cp");
    address internal cp3 = makeAddr("tier3cp");

    bytes32 internal constant IMAGE = keccak256("approved-core-image-v1");

    uint256 internal constant PER_TX = 500_000;
    uint256 internal constant WINDOW_CAP = 800_000;
    uint64 internal constant WINDOW_SECS = 1 days;
    uint256 internal constant CUMULATIVE_CAP = 100_000_000;
    uint256 internal constant TIER2_CAP = 500_000;
    uint64 internal constant DEADMAN_SECS = 7 days;
    uint64 internal constant HOLD_WINDOW = 1 days;
    uint8 internal constant CATEGORY = 7;

    uint256 internal constant ACCOUNT_FUNDING = 1_000_000_000; // ₹10,000,000

    function _deploy() internal {
        (agentSigner, agentPk) = makeAddrAndKey("agent");
        (coreSigner, corePk) = makeAddrAndKey("core");

        vm.warp(1_000_000);

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
            deadmanSeconds: DEADMAN_SECS
        });

        policy = new PolicyModule(init);
        token = new INRx(owner);
        account = new RekhaAccount(owner, IERC20(address(token)), policy, HOLD_WINDOW);

        vm.startPrank(owner);
        policy.setCounterpartyTier(cp1, 1);
        policy.setCounterpartyTier(cp2, 2);
        policy.setCounterpartyTier(cp3, 3);
        policy.setAccount(address(account));
        token.mint(address(account), ACCOUNT_FUNDING);
        vm.stopPrank();
    }

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
}

contract RekhaAccountTest is RekhaTestBase {
    event PaymentExecuted(
        bytes32 indexed decisionId, address indexed counterparty, uint256 amountMinor
    );
    event PaymentHeld(bytes32 indexed decisionId, uint16 softFailBitmask);

    function setUp() public {
        _deploy();
    }

    // 1 — Happy path: valid request executes, balance moves, event emitted.
    function test_1_happyPath_executesAndMovesBalance() public {
        PaymentRequest memory req = _baseReq();
        (bytes memory a, bytes memory c) = _sigs(req);
        bytes32 decisionId = policy.hashRequest(req);

        uint256 accBefore = token.balanceOf(address(account));

        vm.expectEmit(true, true, false, true, address(account));
        emit PaymentExecuted(decisionId, cp1, 400_000);

        vm.prank(relayer);
        account.execute(req, a, c);

        assertEq(token.balanceOf(cp1), 400_000);
        assertEq(token.balanceOf(address(account)), accBefore - 400_000);
        assertTrue(policy.usedNonces(req.nonce));
        assertEq(policy.windowSpentMinor(), 400_000);
        assertEq(policy.cumulativeSpentMinor(), 400_000);
    }

    // 3 — Soft-fail path: tier-2 failing age -> HELD, no transfer.
    function test_3_softFail_heldNoTransfer() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match the registry tier (predicate 8)
        req.counterpartyAgeDays = 10; // below tier-2 minimum -> soft fail
        (bytes memory a, bytes memory c) = _sigs(req);
        bytes32 decisionId = policy.hashRequest(req);

        uint256 accBefore = token.balanceOf(address(account));

        // Only predicate 9 (age) fails -> bitmask bit 0.
        vm.expectEmit(true, false, false, true, address(account));
        emit PaymentHeld(decisionId, policy.SOFT_FAIL_AGE());

        vm.prank(relayer);
        account.execute(req, a, c);

        // No funds moved; nonce not burned; hold recorded and active.
        assertEq(token.balanceOf(cp2), 0);
        assertEq(token.balanceOf(address(account)), accBefore);
        assertFalse(policy.usedNonces(req.nonce));
        (,,,,,, bool active) = account.holds(decisionId);
        assertTrue(active);
    }

    // 3b — Hold bitmask marks exactly which soft predicates (9/10/11) failed.
    function test_3b_heldBitmask_marksEachFailedSoftPredicate() public {
        // A tier-2 request that trips all three soft predicates at once.
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2;
        req.counterpartyAgeDays = 0; // predicate 9  -> 0x1
        req.counterpartySettledTxns = 0; // predicate 10 -> 0x2
        req.priceBandZ = 100; // predicate 11 -> 0x4
        (bytes memory a, bytes memory c) = _sigs(req);
        bytes32 decisionId = policy.hashRequest(req);

        uint16 expected =
            policy.SOFT_FAIL_AGE() | policy.SOFT_FAIL_SETTLED() | policy.SOFT_FAIL_PRICE();
        assertEq(expected, uint16(0x7));
        assertEq(policy.softFailBitmask(req), expected);

        vm.expectEmit(true, false, false, true, address(account));
        emit PaymentHeld(decisionId, expected);
        vm.prank(relayer);
        account.execute(req, a, c);

        // And a request that trips only the price band reports just bit 2.
        PaymentRequest memory req2 = _baseReq();
        req2.counterparty = cp2;
        req2.counterpartyTier = 2;
        req2.nonce = 2;
        req2.priceBandZ = 100; // only predicate 11
        assertEq(policy.softFailBitmask(req2), policy.SOFT_FAIL_PRICE());
    }

    // 4 — Tier 1 skips soft predicates.
    function test_4_tier1_skipsSoftPredicates() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp1;
        req.counterpartyAgeDays = 0;
        req.counterpartySettledTxns = 0;
        req.priceBandZ = 100; // would trip soft predicates for tier 2
        (bytes memory a, bytes memory c) = _sigs(req);

        vm.prank(relayer);
        account.execute(req, a, c);

        assertEq(token.balanceOf(cp1), 400_000); // executed, not held
    }

    // 5 — Tier 3 is hard blocked.
    function test_5_tier3_hardBlocked() public {
        PaymentRequest memory req = _baseReq();
        req.counterparty = cp3;
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.prank(relayer);
        vm.expectRevert(PolicyModule.CounterpartyBlocked.selector);
        account.execute(req, a, c);
    }

    // 6 — Nonce race: fire 50 payments with the same nonce, exactly one succeeds.
    function test_6_nonceRace_exactlyOneSucceeds() public {
        PaymentRequest memory req = _baseReq();
        req.nonce = 42;
        (bytes memory a, bytes memory c) = _sigs(req);

        uint256 successes;
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(relayer);
            try account.execute(req, a, c) {
                successes++;
            } catch {}
        }

        assertEq(successes, 1);
        assertEq(token.balanceOf(cp1), 400_000);
        assertTrue(policy.usedNonces(42));
    }

    // 7 — Revocation: after revoke(), a request with the old epoch reverts.
    function test_7_revocation_oldEpochReverts() public {
        PaymentRequest memory req = _baseReq(); // revocationEpoch = 0
        (bytes memory a, bytes memory c) = _sigs(req);

        vm.prank(owner);
        policy.revoke(); // epoch -> 1

        vm.prank(relayer);
        vm.expectRevert(PolicyModule.StaleRevocationEpoch.selector);
        account.execute(req, a, c);
    }

    // 8 — Monotonic revocation: no sequence of calls decreases revocationEpoch.
    function test_8_revocation_monotonic() public {
        uint64 prev = policy.revocationEpoch();
        address[3] memory callers = [owner, guardian, owner];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            policy.revoke();
            uint64 cur = policy.revocationEpoch();
            assertGt(cur, prev);
            prev = cur;
        }
        // There is no external function that lowers the epoch; only revoke() mutates
        // it and it strictly increases.
        assertEq(policy.revocationEpoch(), 3);
    }

    // 9 — Deadman: advance past deadmanSeconds, checkDeadman() freezes.
    function test_9_deadman_freezes() public {
        assertFalse(policy.frozen());

        // Still within the heartbeat window: no freeze.
        vm.warp(block.timestamp + DEADMAN_SECS);
        policy.checkDeadman();
        assertFalse(policy.frozen());

        // Past the window: freezes.
        vm.warp(block.timestamp + 1);
        policy.checkDeadman();
        assertTrue(policy.frozen());

        // A frozen account approves nothing.
        PaymentRequest memory req = _baseReq();
        req.leaseExpiry = uint64(block.timestamp + 1 days);
        (bytes memory a, bytes memory c) = _sigs(req);
        vm.prank(relayer);
        vm.expectRevert(PolicyModule.AccountFrozen.selector);
        account.execute(req, a, c);
    }

    function test_9b_heartbeat_resetsDeadman() public {
        vm.warp(block.timestamp + DEADMAN_SECS - 1);
        vm.prank(owner);
        policy.heartbeat();
        // Move forward again; because the heartbeat reset the clock, still not lapsed.
        vm.warp(block.timestamp + DEADMAN_SECS);
        policy.checkDeadman();
        assertFalse(policy.frozen());
    }

    // 10 — Guardian: can revoke, cannot spend or change policy.
    function test_10_guardian_canRevoke_cannotChangePolicy() public {
        // Can revoke.
        vm.prank(guardian);
        policy.revoke();
        assertEq(policy.revocationEpoch(), 1);

        // Cannot change policy.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        policy.setPolicy(1, 1, 1, 1, 0, 0, 0, 0, 0);

        // Cannot heartbeat.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        policy.heartbeat();

        // Cannot set tiers.
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian)
        );
        policy.setCounterpartyTier(cp1, 1);

        // Cannot record spend (not the account) -> no way to move funds.
        vm.prank(guardian);
        vm.expectRevert(PolicyModule.OnlyAccount.selector);
        policy.recordSpend(1, 999);
    }

    // 11 — Window rollover: spend to cap, advance past window, spend again.
    function test_11_windowRollover() public {
        // First spend fills most of the window.
        PaymentRequest memory r1 = _baseReq();
        r1.amountMinor = PER_TX; // 500_000
        r1.nonce = 1;
        (bytes memory a1, bytes memory c1) = _sigs(r1);
        vm.prank(relayer);
        account.execute(r1, a1, c1);
        assertEq(policy.windowSpentMinor(), PER_TX);

        // Second spend would exceed the window cap (500k + 400k > 800k).
        PaymentRequest memory r2 = _baseReq();
        r2.amountMinor = 400_000;
        r2.nonce = 2;
        (bytes memory a2, bytes memory c2) = _sigs(r2);
        vm.prank(relayer);
        vm.expectRevert(PolicyModule.WindowCapExceeded.selector);
        account.execute(r2, a2, c2);

        // Advance past the window; the counter rolls and the spend now succeeds.
        vm.warp(block.timestamp + WINDOW_SECS + 1);
        PaymentRequest memory r3 = _baseReq();
        r3.amountMinor = 400_000;
        r3.nonce = 3;
        r3.leaseExpiry = uint64(block.timestamp + 1 days);
        (bytes memory a3, bytes memory c3) = _sigs(r3);
        vm.prank(relayer);
        account.execute(r3, a3, c3);
        assertEq(policy.windowSpentMinor(), 400_000); // rolled, not accumulated
    }

    // 12 — No backdoor: fuzz owner-callable functions and assert the account
    // balance can never decrease (only a validated execute may move funds).
    function test_12_noBackdoor_ownerCannotDrain(
        uint256 sel,
        uint256 amount,
        address who,
        uint8 tier
    ) public {
        uint256 before = token.balanceOf(address(account));

        vm.startPrank(owner);
        uint256 s = sel % 10;
        if (s == 0) {
            try policy.heartbeat() {} catch {}
        } else if (s == 1) {
            try policy.revoke() {} catch {}
        } else if (s == 2) {
            try policy.setPolicy(amount, amount, uint64(amount), amount, amount, 0, 0, 0, amount) {}
                catch {}
        } else if (s == 3) {
            try policy.setCounterpartyTier(who, tier) {} catch {}
        } else if (s == 4) {
            try policy.attestCoreImage(bytes32(amount)) {} catch {}
        } else if (s == 5) {
            try policy.revokeCoreImage() {} catch {}
        } else if (s == 6) {
            try policy.setSigners(who, who) {} catch {}
        } else if (s == 7) {
            try policy.setAccount(who) {} catch {}
        } else if (s == 8) {
            try account.cancelHold(bytes32(amount)) {} catch {}
        } else {
            // Minting can only increase the balance.
            try token.mint(address(account), amount % 1e30) {} catch {}
        }
        vm.stopPrank();

        // The owner, through any of its powers, can never reduce the account balance.
        assertGe(token.balanceOf(address(account)), before);
    }

    // Owner directly trying to move the account's tokens fails: the tokens belong to
    // the account contract, and the owner is not the account.
    function test_12b_noBackdoor_ownerCannotTransferAccountTokens() public {
        uint256 before = token.balanceOf(address(account));
        // Owner has no allowance over the account's balance.
        vm.prank(owner);
        vm.expectRevert();
        token.transferFrom(address(account), owner, 1);
        assertEq(token.balanceOf(address(account)), before);
    }

    // ------------------------------------------------------------------- //
    //                        Hold lifecycle coverage                      //
    // ------------------------------------------------------------------- //

    function _makeHold() internal returns (bytes32 decisionId, PaymentRequest memory req) {
        req = _baseReq();
        req.counterparty = cp2;
        req.counterpartyTier = 2; // must match registry (predicate 8)
        req.counterpartyAgeDays = 10; // soft fail -> HELD
        req.leaseExpiry = uint64(block.timestamp + 30 days); // outlast the hold window
        (bytes memory a, bytes memory c) = _sigs(req);
        decisionId = policy.hashRequest(req);
        vm.prank(relayer);
        account.execute(req, a, c);
    }

    function test_cancelHold_ownerReleases() public {
        (bytes32 id,) = _makeHold();
        vm.prank(owner);
        account.cancelHold(id);
        (,,,,,, bool active) = account.holds(id);
        assertFalse(active);

        // Once cancelled it cannot be settled.
        vm.warp(block.timestamp + HOLD_WINDOW + 1);
        vm.expectRevert(RekhaAccount.HoldNotActive.selector);
        account.settleHold(id);
    }

    function test_cancelHold_onlyOwner() public {
        (bytes32 id,) = _makeHold();
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer)
        );
        account.cancelHold(id);
    }

    function test_settleHold_afterWindow_executes() public {
        (bytes32 id, PaymentRequest memory req) = _makeHold();
        uint256 accBefore = token.balanceOf(address(account));

        // Too early.
        vm.expectRevert(RekhaAccount.HoldWindowNotElapsed.selector);
        account.settleHold(id);

        // After the hold window: settles and moves funds (lease still alive).
        vm.warp(block.timestamp + HOLD_WINDOW + 1);
        account.settleHold(id);

        assertEq(token.balanceOf(cp2), req.amountMinor);
        assertEq(token.balanceOf(address(account)), accBefore - req.amountMinor);
        assertTrue(policy.usedNonces(req.nonce));
    }

    function test_settleHold_blockedByRevocation() public {
        (bytes32 id,) = _makeHold();
        vm.warp(block.timestamp + HOLD_WINDOW + 1);
        vm.prank(owner);
        policy.revoke(); // epoch moves; hold was signed under old epoch
        vm.expectRevert(RekhaAccount.HoldRevoked.selector);
        account.settleHold(id);
    }
}
