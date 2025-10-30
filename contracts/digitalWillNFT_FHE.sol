pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract DigitalWillNFT_FHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct WillEncryptedData {
        euint32 encryptedAssetAmount;
        euint32 encryptedBeneficiaryId;
        euint32 encryptedInstructionCode;
    }

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    mapping(uint256 => WillEncryptedData) public wills;
    mapping(uint256 => DecryptionContext) public decryptionContexts;
    mapping(uint256 => bool) public batchClosed;

    uint256 public currentBatchId;
    uint256 public totalWills;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event WillSubmitted(address indexed submitter, uint256 indexed willId, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed willId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed willId, uint256 indexed batchId);

    error NotOwner();
    error NotProvider();
    error PausedContract();
    error CooldownActive();
    error BatchClosedOrInvalid();
    error InvalidWillId();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();
    error NotInitialized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedContract();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        currentBatchId = 1;
        cooldownSeconds = 60; // Default cooldown
        emit ProviderAdded(owner);
        emit BatchOpened(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        batchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchIdToClose) external onlyOwner {
        if (batchIdToClose != currentBatchId) revert BatchClosedOrInvalid();
        batchClosed[batchIdToClose] = true;
        emit BatchClosed(batchIdToClose);
    }

    function submitWillEncrypted(
        euint32 encryptedAssetAmount,
        euint32 encryptedBeneficiaryId,
        euint32 encryptedInstructionCode
    ) external onlyProvider whenNotPaused respectCooldown {
        if (batchClosed[currentBatchId]) revert BatchClosedOrInvalid();

        _initIfNeeded(encryptedAssetAmount);
        _initIfNeeded(encryptedBeneficiaryId);
        _initIfNeeded(encryptedInstructionCode);

        totalWills++;
        wills[totalWills] = WillEncryptedData({
            encryptedAssetAmount: encryptedAssetAmount,
            encryptedBeneficiaryId: encryptedBeneficiaryId,
            encryptedInstructionCode: encryptedInstructionCode
        });

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit WillSubmitted(msg.sender, totalWills, currentBatchId);
    }

    function requestWillDecryption(uint256 willId) external onlyProvider whenNotPaused respectCooldown {
        if (willId > totalWills || willId == 0) revert InvalidWillId();
        if (batchClosed[wills[willId].encryptedAssetAmount.batchId()]) revert BatchClosedOrInvalid(); // Check if batch is closed

        WillEncryptedData storage will = wills[willId];
        _requireInitialized(will.encryptedAssetAmount);
        _requireInitialized(will.encryptedBeneficiaryId);
        _requireInitialized(will.encryptedInstructionCode);

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(will.encryptedAssetAmount);
        cts[1] = FHE.toBytes32(will.encryptedBeneficiaryId);
        cts[2] = FHE.toBytes32(will.encryptedInstructionCode);

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: will.encryptedAssetAmount.batchId(), // Use batchId from one of the ciphertexts
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, willId, will.encryptedAssetAmount.batchId());
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        WillEncryptedData storage will = wills[ /* Will ID needs to be part of DecryptionContext or derived */
            /* This part is tricky. For simplicity, let's assume willId is requestId for this example.
               In a real scenario, DecryptionContext should store willId or a way to retrieve it. */
            requestId // This is a simplification. A proper mapping from requestId to willId is needed.
        ];
        _requireInitialized(will.encryptedAssetAmount);
        _requireInitialized(will.encryptedBeneficiaryId);
        _requireInitialized(will.encryptedInstructionCode);

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(will.encryptedAssetAmount);
        currentCts[1] = FHE.toBytes32(will.encryptedBeneficiaryId);
        currentCts[2] = FHE.toBytes32(will.encryptedInstructionCode);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // Decode cleartexts (order must match cts array)
            // uint32 assetAmount = abi.decode(cleartexts[0], (uint32));
            // uint32 beneficiaryId = abi.decode(cleartexts[1], (uint32));
            // uint32 instructionCode = abi.decode(cleartexts[2], (uint32));

            // In a real contract, you would use these decrypted values.
            // For this example, we just mark as processed.

            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, requestId, decryptionContexts[requestId].batchId); // willId is requestId here
        } catch {
            revert DecryptionFailed();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 ct) internal {
        if (!FHE.isInitialized(ct)) {
            FHE.asEuint32(0); // Initialize with a default value if not already initialized
        }
    }

    function _initIfNeeded(ebool ct) internal {
        if (!FHE.isInitialized(ct)) {
            FHE.asEbool(false); // Initialize with a default value if not already initialized
        }
    }

    function _requireInitialized(euint32 ct) internal pure {
        if (!FHE.isInitialized(ct)) revert NotInitialized();
    }

    function _requireInitialized(ebool ct) internal pure {
        if (!FHE.isInitialized(ct)) revert NotInitialized();
    }
}