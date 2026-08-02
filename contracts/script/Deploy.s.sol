// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {INRx} from "../src/INRx.sol";
import {PolicyModule, PolicyInit} from "../src/PolicyModule.sol";
import {RekhaAccount} from "../src/RekhaAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Deploy — deploys and wires the Lakshman Rekha contracts
/// @notice Deploys INRx, PolicyModule and RekhaAccount, then links the account to
///         the policy so it may record spends. Counterparty tiers and initial
///         minting are left as post-deploy owner operations.
/// @dev DO NOT run without a funded deployer key and RPC. Configuration is read
///      from environment variables with safe fallbacks so the script always
///      compiles. Run with:
///        forge script script/Deploy.s.sol:Deploy --rpc-url <RPC> --broadcast
///      The deployer is assumed to be the owner; if not, call setAccount from the
///      owner separately.
contract Deploy is Script {
    function run() external {
        // --- Deployer / owner ---
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        require(deployerKey != 0, "set DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address owner = vm.envOr("OWNER", deployer);
        address guardian = vm.envOr("GUARDIAN", deployer);
        address agentSigner = vm.envOr("AGENT_SIGNER", address(0));
        address coreSigner = vm.envOr("CORE_SIGNER", address(0));
        bytes32 coreImageDigest = vm.envOr("CORE_IMAGE_DIGEST", bytes32(0));
        require(agentSigner != address(0), "set AGENT_SIGNER");
        require(coreSigner != address(0), "set CORE_SIGNER");
        require(coreImageDigest != bytes32(0), "set CORE_IMAGE_DIGEST");

        // --- Policy parameters (minor units / paise). Tune per deployment. ---
        PolicyInit memory init = PolicyInit({
            owner: owner,
            guardian: guardian,
            agentSigner: agentSigner,
            coreSigner: coreSigner,
            coreImageDigest: coreImageDigest,
            perTxCapMinor: vm.envOr("PER_TX_CAP", uint256(1_000_000)), // ₹10,000
            windowCapMinor: vm.envOr("WINDOW_CAP", uint256(10_000_000)), // ₹100,000
            windowSeconds: uint64(vm.envOr("WINDOW_SECONDS", uint256(1 days))),
            cumulativeCapMinor: vm.envOr("CUMULATIVE_CAP", uint256(100_000_000)), // ₹1,000,000
            permittedCategories: vm.envOr("PERMITTED_CATEGORIES", uint256(1) << 7),
            tier2MinAgeDays: uint16(vm.envOr("TIER2_MIN_AGE_DAYS", uint256(30))),
            tier2MinSettledTxns: uint32(vm.envOr("TIER2_MIN_SETTLED", uint256(5))),
            tier2MaxPriceBandZ: int8(int256(vm.envOr("TIER2_MAX_PRICE_BAND_Z", uint256(2)))),
            tier2CapMinor: vm.envOr("TIER2_CAP", uint256(500_000)), // ₹5,000
            deadmanSeconds: uint64(vm.envOr("DEADMAN_SECONDS", uint256(7 days)))
        });

        uint64 holdWindowSeconds = uint64(vm.envOr("HOLD_WINDOW_SECONDS", uint256(1 days)));

        vm.startBroadcast(deployerKey);

        INRx token = new INRx(owner);
        PolicyModule policy = new PolicyModule(init);
        RekhaAccount account =
            new RekhaAccount(owner, IERC20(address(token)), policy, holdWindowSeconds);

        // Link the account so it may call recordSpend. Only works if the broadcaster
        // is the policy owner; otherwise the owner must call setAccount separately.
        if (deployer == owner) {
            policy.setAccount(address(account));
        }

        vm.stopBroadcast();

        console2.log("INRx:        ", address(token));
        console2.log("PolicyModule:", address(policy));
        console2.log("RekhaAccount:", address(account));
        if (deployer != owner) {
            console2.log("NOTE: call policy.setAccount(account) from the owner to finish wiring.");
        }
    }
}
