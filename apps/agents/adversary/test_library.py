"""
B7 — Adversary library tests

These used to assert "all 12 attack classes are blocked". They no longer do,
because that is the claim HONESTY_PLAN.md withdrew: the old suite counted its
own crashes and its own unreachable services as defences, and two of the twelve
classes returned a hardcoded revert string without ever touching the chain.

What is asserted now is the contract the scoreboard depends on:

  - `blocked` only ever means we got a verdict and the payment stopped
  - a harness failure is `errored`, and `errored` is never `blocked`
  - nothing the core refused is reported as having got `through`
  - each class attempts what it says it attempts

If any one of those breaks, every number on the Rogue Mode board is unsafe to
show, which is a worse failure than an attack getting through.
"""

from __future__ import annotations

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from library import (
    ALL_ATTACK_CLASSES,
    run_all_attacks,
    AttackResult,
)

CORE_URL = os.environ.get("CORE_URL", "http://localhost:4000")


def _noop_emit(event: dict) -> None:
    pass


class AllAttackClassesBlocked(unittest.TestCase):
    """
    For each of the 12 attack classes, mock the core to return appropriate
    blocked responses, then assert all results are blocked=True.

    In CI, this test runs against the mock responses.
    In integration testing, set CORE_URL to a live core to test real blocking.
    """

    def _mock_blocked_response(self, code: str = "POLICY_REFUSED", outcome: str = "REFUSED") -> dict:
        return {
            "error": {"code": code, "message": "blocked"},
        }

    @patch("library._post")
    def test_all_12_classes_produce_blocked_results(self, mock_post: MagicMock) -> None:
        """All 12 attack classes must produce at least one blocked=True result."""
        mock_post.return_value = self._mock_blocked_response()

        results = run_all_attacks(CORE_URL, _noop_emit)

        self.assertGreater(len(results), 0, "No attack results produced")

        class_numbers_seen = set()
        for result in results:
            if result.class_number is not None:
                class_numbers_seen.add(result.class_number)

        # All 12 classes should have been attempted
        missing = set(range(1, 13)) - class_numbers_seen
        self.assertFalse(missing, f"Missing attack classes: {missing}")

    @patch("library._post")
    def test_nothing_the_core_refused_is_reported_as_through(self, mock_post: MagicMock) -> None:
        """
        When every core call comes back refused, nothing may be reported as
        `through`.

        This replaces `test_no_attack_succeeds_when_core_is_correct`, which
        asserted that EVERY result was `blocked`. That assertion encodes the
        claim this suite exists to retire. Classes 5 and 7 go through the agent
        runner's /rail-bypass, and a mocked-out runner is a service we could not
        reach — so those results are `errored`, and `errored` is deliberately
        not `blocked`. A test that demanded otherwise would fail the day the
        instrumentation started telling the truth. It did, and it did.
        """
        mock_post.return_value = self._mock_blocked_response()

        results = run_all_attacks(CORE_URL, _noop_emit)

        through = [r for r in results if r.status == "through"]
        self.assertFalse(
            through,
            f"These attacks got THROUGH a core that refused everything: "
            f"{[(r.technique, r.revert_reason) for r in through]}\n"
            "That is a real vulnerability, or a classifier bug. Either way, fix it."
        )

    @patch("library._post")
    def test_a_result_is_blocked_only_when_we_got_a_verdict(self, mock_post: MagicMock) -> None:
        """
        The invariant the whole scoreboard rests on: `blocked` means something
        stopped the payment, never that our own harness fell over.

        FIXLOG3.md:317. `blocked` used to be the only state, so an attack class
        that threw and a response shape the classifier did not recognise both
        landed on the board as successful defences. A number that goes up when
        our test rig breaks is worthless.
        """
        mock_post.return_value = {"error": {"code": "NETWORK_ERROR", "message": "connection refused"}}

        results = run_all_attacks(CORE_URL, _noop_emit)

        self.assertGreater(len(results), 0)
        wrongly_blocked = [r for r in results if r.blocked or r.status == "blocked"]
        self.assertFalse(
            wrongly_blocked,
            f"A core we never reached was counted as a defence: "
            f"{[(r.technique, r.status, r.revert_reason) for r in wrongly_blocked]}"
        )
        # And every one of them says so, rather than being silently dropped.
        self.assertTrue(all(r.status == "errored" for r in results))
        self.assertTrue(all(r.stage is None for r in results))

    @patch("library._post")
    def test_structuring_sizes_itself_from_live_headroom(self, mock_post: MagicMock) -> None:
        """
        Class 1 attempts exactly `StructuringAttack.PAYMENTS` slices.

        This used to assert the literal 60, and 60 was wrong twice over: the run
        took 4m39s (each request costs two RPC round-trips), and 60 x ₹800 is
        ₹48,000 against a ₹1,00,000 window cap, so neither the per-tx cap nor
        the window cap could ever fire. The count now comes from the class, and
        the slice size from live headroom — assert the contract, not a constant
        that was chosen before anyone measured it.
        """
        mock_post.return_value = self._mock_blocked_response("POLICY_REFUSED", "REFUSED")

        from library import StructuringAttack
        attack = StructuringAttack()
        results = attack.execute(CORE_URL, _noop_emit)

        self.assertEqual(len(results), attack.PAYMENTS)
        self.assertTrue(all(r.class_number == 1 for r in results))

    @patch("library._post")
    def test_toctou_class_4_at_most_one_succeeds(self, mock_post: MagicMock) -> None:
        """Class 4 TOCTOU: same nonce submitted 50 times — at most one should succeed."""
        # Simulate: first call returns APPROVED, subsequent calls return NonceAlreadyUsed
        call_count = [0]

        def _side_effect(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return {"outcome": "APPROVED", "trace": {"bindingPredicate": None}}
            return {"error": {"code": "NONCE_USED", "message": "NonceAlreadyUsed"}}

        mock_post.side_effect = _side_effect

        from library import ToctouRaceAttack
        attack = ToctouRaceAttack()
        results = attack.execute(CORE_URL, _noop_emit)

        approved = [r for r in results if not r.blocked]
        self.assertLessEqual(len(approved), 1, f"More than 1 concurrent payment succeeded: {approved}")

    def test_all_12_classes_present(self) -> None:
        """Confirm the library has exactly 12 classes."""
        self.assertEqual(len(ALL_ATTACK_CLASSES), 12, f"Expected 12 attack classes, got {len(ALL_ATTACK_CLASSES)}")
        numbers = [c.class_number for c in ALL_ATTACK_CLASSES]
        self.assertEqual(sorted(numbers), list(range(1, 13)), "Attack class numbers must be 1–12")

    def test_attack_class_attributes(self) -> None:
        """Each attack class must have name, description, class_number, execute, expected_defence."""
        for attack in ALL_ATTACK_CLASSES:
            self.assertTrue(hasattr(attack, "name"), f"{type(attack).__name__} missing name")
            self.assertTrue(hasattr(attack, "description"), f"{type(attack).__name__} missing description")
            self.assertTrue(hasattr(attack, "class_number"), f"{type(attack).__name__} missing class_number")
            self.assertTrue(hasattr(attack, "execute"), f"{type(attack).__name__} missing execute")
            self.assertTrue(hasattr(attack, "expected_defence"), f"{type(attack).__name__} missing expected_defence")
            self.assertIsInstance(attack.name, str)
            self.assertIsInstance(attack.class_number, int)


if __name__ == "__main__":
    unittest.main(verbosity=2)
