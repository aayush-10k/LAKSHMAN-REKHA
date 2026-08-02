// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract PolicyModule {
    using ECDSA for bytes32;

    address public owner;
    address public guardian;
    address public agentSigner;
    address public coreSigner;

    uint64 public revocationEpoch;
    bytes32 public policyHash;
    bytes32 public coreImageDigest;

    error InvalidAgentSignature();
    error InvalidCoreSignature();
    // Add others later as needed for Phase 2+

    constructor(address _owner, address _agentSigner, address _coreSigner) {
        owner = _owner;
        agentSigner = _agentSigner;
        coreSigner = _coreSigner;
    }

    function validate(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig) external view returns (bool) {
        bytes32 digest = keccak256(abi.encode(req));
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(digest);

        address recoveredAgent = hash.recover(agentSig);
        if (recoveredAgent != agentSigner) {
            revert InvalidAgentSignature();
        }

        address recoveredCore = hash.recover(coreSig);
        if (recoveredCore != coreSigner) {
            revert InvalidCoreSignature();
        }

        return true;
    }
}
