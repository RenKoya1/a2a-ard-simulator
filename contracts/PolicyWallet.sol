// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "./Escrow8183.sol";

interface IEscrow8183 {
    function fund(address provider, uint256 amount, string calldata jobRef, address evaluator) external returns (uint256);
}

/// @title PolicyWallet — ERC-8196/4337-style agent wallet with on-chain spending policy.
/// @notice Holds the agent's USDC. Every outflow — a direct x402 payment or an
///         ERC-8183 escrow funding — is checked against a per-transaction cap and
///         a cumulative cap enforced by this contract. A compromised or persuaded
///         agent holding the key still cannot spend past these ceilings: the policy
///         lives where the prompt cannot reach. Direct payments produce receipts
///         that the payee consumes exactly once (x402 replay guard).
contract PolicyWallet {
    struct Receipt {
        address payer;
        address to;
        uint256 amount;
        bool consumed;
    }

    address public immutable owner; // the agent's EOA (the "persuadable key-holder")
    IERC20 public immutable usdc;

    uint256 public perTxCap;
    uint256 public cumulativeCap;
    uint256 public spent;
    uint256 private nonce;

    mapping(bytes32 => Receipt) public receipts;

    event CapsUpdated(uint256 perTxCap, uint256 cumulativeCap);
    event PaymentSettled(bytes32 indexed receiptId, address indexed to, uint256 amount, string memo);
    event ReceiptConsumed(bytes32 indexed receiptId, address indexed by);
    event EscrowFunded(uint256 indexed jobId, address indexed escrow, address indexed provider, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "wallet: not the owner");
        _;
    }

    constructor(IERC20 _usdc, uint256 _perTxCap, uint256 _cumulativeCap) {
        owner = msg.sender;
        usdc = _usdc;
        perTxCap = _perTxCap;
        cumulativeCap = _cumulativeCap;
    }

    function setCaps(uint256 _perTxCap, uint256 _cumulativeCap) external onlyOwner {
        perTxCap = _perTxCap;
        cumulativeCap = _cumulativeCap;
        emit CapsUpdated(_perTxCap, _cumulativeCap);
    }

    function _checkPolicy(uint256 amount) internal {
        require(amount > 0, "wallet: zero amount");
        require(amount <= perTxCap, "wallet: exceeds per-tx cap");
        require(spent + amount <= cumulativeCap, "wallet: exceeds cumulative cap");
        spent += amount;
    }

    /// @notice Direct x402 payment. Emits a receipt the payee can consume once.
    function pay(address to, uint256 amount, string calldata memo) external onlyOwner returns (bytes32 receiptId) {
        _checkPolicy(amount);
        require(usdc.transfer(to, amount), "wallet: transfer failed");
        receiptId = keccak256(abi.encodePacked(address(this), to, amount, nonce++));
        receipts[receiptId] = Receipt(address(this), to, amount, false);
        emit PaymentSettled(receiptId, to, amount, memo);
    }

    /// @notice x402 replay guard: only the payee may consume, and only once.
    function consume(bytes32 receiptId) external {
        Receipt storage r = receipts[receiptId];
        require(r.to != address(0), "wallet: unknown receipt");
        require(msg.sender == r.to, "wallet: not the payee");
        require(!r.consumed, "wallet: receipt already consumed");
        r.consumed = true;
        emit ReceiptConsumed(receiptId, msg.sender);
    }

    /// @notice Fund an ERC-8183 escrow under the same spending policy.
    function fundEscrow(
        IEscrow8183 escrow,
        address provider,
        uint256 amount,
        string calldata jobRef
    ) external onlyOwner returns (uint256 jobId) {
        _checkPolicy(amount);
        require(usdc.approve(address(escrow), amount), "wallet: approve failed");
        jobId = escrow.fund(provider, amount, jobRef, owner);
        emit EscrowFunded(jobId, address(escrow), provider, amount);
    }
}
