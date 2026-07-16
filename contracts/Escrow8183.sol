// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @title Escrow8183 — ERC-8183-style job escrow: fund → deliver → evaluator attests → release/refund.
/// @notice The client funds a job up front; funds only move to the provider once the
///         designated evaluator attests delivery. A failed attestation refunds the client.
contract Escrow8183 {
    enum Status {
        None,
        Funded,
        Released,
        Refunded
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint256 amount;
        string jobRef;
        Status status;
    }

    IERC20 public immutable usdc;
    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    event EscrowFunded(uint256 indexed jobId, address indexed client, address indexed provider, uint256 amount, string jobRef);
    event EscrowAttested(uint256 indexed jobId, address indexed evaluator, bool pass);

    constructor(IERC20 _usdc) {
        usdc = _usdc;
    }

    /// @dev Caller must have approved this contract for `amount` beforehand.
    function fund(
        address provider,
        uint256 amount,
        string calldata jobRef,
        address evaluator
    ) external returns (uint256 jobId) {
        require(amount > 0, "escrow: zero amount");
        require(usdc.transferFrom(msg.sender, address(this), amount), "escrow: funding failed");
        jobId = nextJobId++;
        jobs[jobId] = Job(msg.sender, provider, evaluator, amount, jobRef, Status.Funded);
        emit EscrowFunded(jobId, msg.sender, provider, amount, jobRef);
    }

    function attest(uint256 jobId, bool pass) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.Funded, "escrow: not funded");
        require(msg.sender == job.evaluator, "escrow: not the evaluator");
        if (pass) {
            job.status = Status.Released;
            require(usdc.transfer(job.provider, job.amount), "escrow: release failed");
        } else {
            job.status = Status.Refunded;
            require(usdc.transfer(job.client, job.amount), "escrow: refund failed");
        }
        emit EscrowAttested(jobId, msg.sender, pass);
    }
}
