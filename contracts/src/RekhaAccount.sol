// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";
import "./PolicyModule.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RekhaAccount {
    IERC20 public inrx;
    PolicyModule public policy;

    event PaymentExecuted(bytes32 indexed decisionId, address counterparty, uint256 amountMinor);

    constructor(address _inrx, address _policy) {
        inrx = IERC20(_inrx);
        policy = PolicyModule(_policy);
    }

    function balanceMinor() external view returns (uint256) {
        return inrx.balanceOf(address(this));
    }

    function execute(PaymentRequest calldata req, bytes calldata agentSig, bytes calldata coreSig, bytes32 decisionId) external {
        // Validate against policy module
        require(policy.validate(req, agentSig, coreSig), "Policy validation failed");
        
        // Execute payment
        require(inrx.transfer(req.counterparty, req.amountMinor), "Transfer failed");

        emit PaymentExecuted(decisionId, req.counterparty, req.amountMinor);
    }
}
