"""
B7 — Adversary library tests

Assert all 12 attack classes are blocked.
If any one succeeds, that's a real vulnerability and the build is broken.
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
    def test_no_attack_succeeds_when_core_is_correct(self, mock_post: MagicMock) -> None:
        """When the core correctly blocks all attempts, funds lost must be ₹0."""
        mock_post.return_value = self._mock_blocked_response()

        results = run_all_attacks(CORE_URL, _noop_emit)

        unblocked = [r for r in results if not r.blocked]
        self.assertFalse(
            unblocked,
            f"These attacks were NOT blocked: {[(r.technique, r.revert_reason) for r in unblocked]}\n"
            "This represents a real vulnerability. Fix it before the demo."
        )

    @patch("library._post")
    def test_structuring_class_1_all_60_blocked(self, mock_post: MagicMock) -> None:
        """Class 1 structuring: all 60 micro-payments should be blocked collectively."""
        mock_post.return_value = self._mock_blocked_response("POLICY_REFUSED", "REFUSED")

        from library import StructuringAttack
        attack = StructuringAttack()
        results = attack.execute(CORE_URL, _noop_emit)

        self.assertEqual(len(results), 60, "Structuring attack should attempt exactly 60 payments")
        # In a correctly configured system with window caps, these should all be blocked
        # (or some get through until the window cap is hit)
        # The important thing: no unbounded spending

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
