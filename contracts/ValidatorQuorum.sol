// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AgentRegistry8004.sol";

/// @notice Simulation of a consumer-selected, fixed 2-of-3 validation committee.
///         Transactions authenticate operators; their reports are synthetic.
///         This is an application policy, not an ERC-8004 requirement or a truth oracle.
contract ValidatorQuorum {
    struct Round {
        uint256 id;
        uint256 expiresAt;
        uint8 approvals;
        uint8 responses;
        uint8 score;
    }
    struct Vote {
        uint256 roundId;
        uint8 score;
        bytes32 reportHash;
    }

    address public immutable controller;
    AgentRegistry8004 public immutable registry;
    address[3] public members;
    mapping(address => bool) public isMember;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Vote)) public votes;

    event RoundOpened(uint256 indexed agentId, uint256 indexed roundId, uint256 expiresAt);
    event VoteRecorded(uint256 indexed agentId, uint256 indexed roundId, address indexed validator, uint8 score, bytes32 reportHash);

    constructor(address[3] memory operators) {
        controller = msg.sender;
        for (uint256 i; i < 3; i++) {
            require(operators[i] != address(0) && !isMember[operators[i]], "quorum: invalid member");
            members[i] = operators[i];
            isMember[operators[i]] = true;
        }
        registry = new AgentRegistry8004(address(this));
    }

    function beginRound(uint256 agentId, uint256 validFor) external {
        require(msg.sender == controller, "quorum: not controller");
        require(validFor > 0 && validFor <= 1 days, "quorum: invalid lifetime");
        // The registry checks agent existence. Opening a new round invalidates old approval.
        registry.setValidation(agentId, 0);
        uint256 next = rounds[agentId].id + 1;
        rounds[agentId] = Round(next, block.timestamp + validFor, 0, 0, 100);
        emit RoundOpened(agentId, next, block.timestamp + validFor);
    }

    function submit(uint256 agentId, uint256 roundId, uint8 score, bytes32 reportHash) external {
        require(isMember[msg.sender], "quorum: untrusted validator");
        Round storage r = rounds[agentId];
        require(r.id != 0 && r.id == roundId, "quorum: wrong round");
        require(block.timestamp < r.expiresAt, "quorum: expired");
        require(votes[agentId][msg.sender].roundId != roundId, "quorum: duplicate vote");
        require(score <= 100 && reportHash != bytes32(0), "quorum: invalid report");
        votes[agentId][msg.sender] = Vote(roundId, score, reportHash);
        r.responses++;
        if (score >= 60) {
            r.approvals++;
            if (score < r.score) r.score = score;
        }
        registry.setValidation(agentId, r.approvals >= 2 ? r.score : 0);
        emit VoteRecorded(agentId, roundId, msg.sender, score, reportHash);
    }

    /// @dev Consumers must check freshness here; a historical registry score can expire.
    function status(uint256 agentId) external view returns (Round memory round, bool eligible, uint8 score) {
        round = rounds[agentId];
        eligible = round.id != 0 && block.timestamp < round.expiresAt && round.approvals >= 2;
        score = eligible ? round.score : 0;
    }
}
