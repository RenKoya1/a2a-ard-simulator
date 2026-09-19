// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Local-devnet incentive experiment for signed integer addition.
/// Correctness comes from deterministic re-execution, NEVER majority voting.
/// The bounded pool and block-derived draw are demo conveniences, not secure
/// randomness, Sybil resistance, Ethereum consensus, or a production PoS protocol.
contract StakedValidator {
    uint256 public constant BOND = 1 ether;
    uint256 public constant REWARD = 0.01 ether;
    uint256 public constant FEE = 3 * REWARD;
    uint256 public constant NO_SHOW_PENALTY = 0.1 ether;
    uint256 public constant COMMIT_BLOCKS = 20;
    uint256 public constant REVEAL_BLOCKS = 20;
    uint256 public constant CHALLENGE_BLOCKS = 10;

    struct Job {
        address requester;
        int64 a;
        int64 b;
        int128 claimed;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 challengeEnd;
        address[3] committee;
        bool finalized;
        bool accepted;
    }
    struct Submission {
        bytes32 commitment;
        int128 answer;
        bool revealed;
        address challenger;
    }

    address[] public operators;
    mapping(address => bool) public registered;
    mapping(address => uint256) public stake;
    mapping(address => uint256) public locked;
    mapping(address => uint256) public credit;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public slashed;
    mapping(address => uint256) public bounties;
    mapping(uint256 => Job) private jobs;
    mapping(uint256 => mapping(address => Submission)) public submissions;
    uint256 public nextJobId = 1;
    // Unawarded slashes stay in an inaccessible reserve, never reward the majority.
    uint256 public reserve;

    event Deposited(address indexed validator, uint256 amount);
    event JobOpened(uint256 indexed jobId, address indexed requester, address[3] committee);
    event Committed(uint256 indexed jobId, address indexed validator, bytes32 commitment);
    event Revealed(uint256 indexed jobId, address indexed validator, int128 answer);
    event FraudProven(uint256 indexed jobId, address indexed validator, address indexed challenger);
    event ValidatorSettled(uint256 indexed jobId, address indexed validator, uint256 reward, uint256 penalty);
    event Finalized(uint256 indexed jobId, bool accepted, int128 correctAnswer);

    function deposit() external payable {
        require(msg.value > 0, "stake: zero deposit");
        if (!registered[msg.sender]) {
            require(operators.length < 16, "stake: demo pool full");
            registered[msg.sender] = true;
            operators.push(msg.sender);
        }
        stake[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdrawStake(uint256 amount) external {
        require(amount > 0 && amount <= stake[msg.sender] - locked[msg.sender], "stake: funds locked");
        stake[msg.sender] -= amount;
        _send(msg.sender, amount);
    }

    function withdrawCredit() external {
        uint256 amount = credit[msg.sender];
        require(amount > 0, "stake: no credit");
        credit[msg.sender] = 0;
        _send(msg.sender, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "stake: transfer failed");
    }

    function openJob(int64 a, int64 b, int128 claimed) external payable returns (uint256 id) {
        require(msg.value == FEE, "stake: exact fee required");
        address[16] memory candidates;
        uint256 count;
        for (uint256 i; i < operators.length; i++) {
            address operator = operators[i];
            if (stake[operator] - locked[operator] >= BOND) candidates[count++] = operator;
        }
        require(count >= 3, "stake: insufficient validators");
        id = nextJobId++;
        Job storage j = jobs[id];
        j.requester = msg.sender;
        j.a = a;
        j.b = b;
        j.claimed = claimed;
        j.commitEnd = block.number + COMMIT_BLOCKS;
        j.revealEnd = j.commitEnd + REVEAL_BLOCKS;
        j.challengeEnd = j.revealEnd + CHALLENGE_BLOCKS;
        // Manipulable block entropy: use a verifiable randomness protocol in production.
        bytes32 seed = keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, id));
        for (uint256 i; i < 3; i++) {
            uint256 pick = uint256(keccak256(abi.encode(seed, i))) % count;
            address operator = candidates[pick];
            j.committee[i] = operator;
            locked[operator] += BOND;
            candidates[pick] = candidates[--count];
        }
        emit JobOpened(id, msg.sender, j.committee);
    }

    function getJob(uint256 id) external view returns (Job memory) { return jobs[id]; }

    function commitmentFor(uint256 id, address validator, int128 answer, bytes32 salt) public view returns (bytes32) {
        // Binding to chain, contract, job and validator prevents copying/replay.
        return keccak256(abi.encode(block.chainid, address(this), id, validator, answer, salt));
    }

    function commit(uint256 id, bytes32 commitment) external {
        Job storage j = jobs[id];
        require(j.requester != address(0) && block.number <= j.commitEnd, "stake: commit closed");
        require(_selected(j, msg.sender), "stake: not selected");
        Submission storage s = submissions[id][msg.sender];
        require(commitment != bytes32(0) && s.commitment == bytes32(0), "stake: invalid commitment");
        s.commitment = commitment;
        emit Committed(id, msg.sender, commitment);
    }

    function reveal(uint256 id, int128 answer, bytes32 salt) external {
        Job storage j = jobs[id];
        require(block.number > j.commitEnd && block.number <= j.revealEnd, "stake: reveal closed");
        require(_selected(j, msg.sender), "stake: not selected");
        Submission storage s = submissions[id][msg.sender];
        require(!s.revealed && s.commitment == commitmentFor(id, msg.sender, answer, salt), "stake: invalid reveal");
        s.answer = answer;
        s.revealed = true;
        emit Revealed(id, msg.sender, answer);
    }

    function proveFraud(uint256 id, address validator) external {
        Job storage j = jobs[id];
        require(block.number > j.revealEnd && block.number <= j.challengeEnd, "stake: challenge closed");
        Submission storage s = submissions[id][validator];
        require(s.revealed && s.answer != _answer(j), "stake: no fraud");
        require(s.challenger == address(0), "stake: already challenged");
        s.challenger = msg.sender;
        emit FraudProven(id, validator, msg.sender);
    }

    function finalize(uint256 id) external {
        Job storage j = jobs[id];
        require(j.requester != address(0) && block.number > j.challengeEnd, "stake: not ready");
        require(!j.finalized, "stake: already finalized");
        j.finalized = true;
        int128 correct = _answer(j);
        uint256 paid;
        bool verified;
        for (uint256 i; i < 3; i++) {
            address operator = j.committee[i];
            Submission storage s = submissions[id][operator];
            uint256 reward;
            uint256 penalty;
            if (!s.revealed) penalty = NO_SHOW_PENALTY;
            else if (s.answer != correct) penalty = BOND;
            else {
                verified = true;
                reward = REWARD;
                credit[operator] += reward;
                rewards[operator] += reward;
                paid += reward;
            }
            locked[operator] -= BOND;
            stake[operator] -= penalty;
            slashed[operator] += penalty;
            uint256 bounty = s.challenger == address(0) ? 0 : penalty / 5;
            if (bounty > 0) {
                credit[s.challenger] += bounty;
                bounties[s.challenger] += bounty;
            }
            reserve += penalty - bounty;
            emit ValidatorSettled(id, operator, reward, penalty);
        }
        // A single correct minority is sufficient because Solidity verifies the answer.
        // No valid reveal fails closed, even if the worker happened to be correct.
        j.accepted = verified && j.claimed == correct;
        credit[j.requester] += FEE - paid;
        emit Finalized(id, j.accepted, correct);
    }

    function _answer(Job storage j) private view returns (int128) { return int128(j.a) + int128(j.b); }
    function _selected(Job storage j, address operator) private view returns (bool) {
        return j.committee[0] == operator || j.committee[1] == operator || j.committee[2] == operator;
    }
}
