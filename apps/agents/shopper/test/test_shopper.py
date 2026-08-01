import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from shopper import build_shopper


class ShopperTest(unittest.TestCase):
    def test_graph_compiles(self):
        self.assertIsNotNone(build_shopper())


if __name__ == "__main__":
    unittest.main()
