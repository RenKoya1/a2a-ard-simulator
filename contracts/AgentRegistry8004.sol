// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentRegistry8004 — ERC-8004-style Identity + Validation registries.
/// @notice Identity: agents self-register their ARD identifier, domain, and card URL
///         from their own account (the account doubles as the agent's wallet).
///         Validation: a designated validator records a 0-100 score per agent.
///         Deliberately minimal: it models the registry *roles*, not the full EIP.
contract AgentRegistry8004 {
    struct Agent {
        uint256 agentId;
        address owner; // the agent's account; also where x402 payments go
        string identifier; // urn:air:<publisher>:<namespace>:<name>
        string domain;
        string cardUrl;
    }

    address public immutable validator;
    uint256 public nextAgentId = 1;

    mapping(bytes32 => Agent) private agentsByIdHash;
    mapping(uint256 => bytes32) public idHashByAgentId;
    mapping(uint256 => uint8) public validationScore;

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string identifier);
    event ValidationRecorded(uint256 indexed agentId, address indexed validator, uint8 score);

    constructor(address _validator) {
        validator = _validator;
    }

    function register(
        string calldata identifier,
        string calldata domain,
        string calldata cardUrl
    ) external returns (uint256 agentId) {
        bytes32 idHash = keccak256(bytes(identifier));
        require(agentsByIdHash[idHash].agentId == 0, "registry: already registered");
        agentId = nextAgentId++;
        agentsByIdHash[idHash] = Agent(agentId, msg.sender, identifier, domain, cardUrl);
        idHashByAgentId[agentId] = idHash;
        emit AgentRegistered(agentId, msg.sender, identifier);
    }

    function setValidation(uint256 agentId, uint8 score) external {
        require(msg.sender == validator, "registry: not the validator");
        require(idHashByAgentId[agentId] != bytes32(0), "registry: unknown agent");
        require(score <= 100, "registry: score > 100");
        validationScore[agentId] = score;
        emit ValidationRecorded(agentId, msg.sender, score);
    }

    function byIdentifier(
        string calldata identifier
    )
        external
        view
        returns (bool registered, uint256 agentId, address owner, string memory domain, string memory cardUrl, uint8 score)
    {
        Agent storage a = agentsByIdHash[keccak256(bytes(identifier))];
        if (a.agentId == 0) return (false, 0, address(0), "", "", 0);
        return (true, a.agentId, a.owner, a.domain, a.cardUrl, validationScore[a.agentId]);
    }
}
