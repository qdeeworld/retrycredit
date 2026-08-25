// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinSeaDropRetryVerifier} from "./AttestcoinSeaDropRetryVerifier.sol";
import {SeaDropPaidRetryPredicateV1} from "./SeaDropPaidRetryPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

/// @notice A fixed-credit pool for already-attested, organic Ethereum SeaDrop retries.
/// @dev Campaign terms and funding cannot be changed after creation. Proofs determine their own beneficiary.
contract RetryCreditRecoveryCampaign is ReentrancyGuard {
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;
    uint64 public constant SOURCE_CHAIN_KEY = 3;
    uint64 public constant SOURCE_CHAIN_ID = 1;
    uint64 public constant MAX_CAMPAIGN_DURATION = 30 days;

    struct Campaign {
        address sponsor;
        uint256 creditAmount;
        uint32 maxClaims;
        uint32 claimCount;
        uint64 deadline;
        uint256 fundedAmount;
        bytes32 termsHash;
        bool remainderRecovered;
    }

    AttestcoinSeaDropRetryVerifier public immutable retryVerifier;
    SeaDropPaidRetryPredicateV1 public immutable predicate;
    IChainInfo public immutable chainInfo;

    uint256 public campaignCount;
    uint256 public accountedBalance;

    mapping(uint256 campaignNumber => Campaign) private campaigns;
    mapping(uint256 campaignNumber => SeaDropPaidRetryPredicateV1.Rule) private rules;
    mapping(uint256 campaignNumber => mapping(address beneficiary => bool)) public claimedByCampaign;
    mapping(uint256 campaignNumber => mapping(bytes32 queryId => bool)) public consumedQueries;
    mapping(uint256 campaignNumber => mapping(bytes32 pairId => bool)) public consumedPairs;

    event CampaignCreated(
        uint256 indexed campaignNumber,
        address indexed sponsor,
        address indexed feeRecipient,
        uint256 creditAmount,
        uint32 maxClaims,
        uint64 deadline,
        uint64 startBlock,
        uint64 endBlock,
        bytes32 termsHash
    );
    event CreditReleased(
        uint256 indexed campaignNumber,
        address indexed beneficiary,
        bytes32 indexed actionId,
        uint256 creditAmount,
        bytes32 failureQueryId,
        bytes32 successQueryId,
        bytes32 pairId,
        address relayer,
        uint32 claimCount
    );
    event RemainderRecovered(uint256 indexed campaignNumber, address indexed sponsor, uint256 amount);

    error AlreadyClaimed();
    error AlreadyRecovered();
    error CampaignClosed();
    error CampaignFull();
    error InvalidCampaign();
    error InvalidConfiguration();
    error InvalidDeadline();
    error InvalidFunding();
    error InvalidSourceChain();
    error InvalidVerification();
    error NotSponsor();
    error RecoveryClosed();
    error Replay();
    error SourceWindowNotAttested();
    error TransferFailed();

    constructor(AttestcoinSeaDropRetryVerifier retryVerifier_, address chainInfoOverride) {
        if (address(retryVerifier_) == address(0) || address(retryVerifier_).code.length == 0) {
            revert InvalidConfiguration();
        }
        SeaDropPaidRetryPredicateV1 predicate_ = retryVerifier_.predicate();
        if (
            address(predicate_) == address(0) || address(predicate_).code.length == 0
                || address(retryVerifier_.verifier()) == address(0)
                || retryVerifier_.SOURCE_CHAIN_KEY() != SOURCE_CHAIN_KEY
                || retryVerifier_.SOURCE_CHAIN_ID() != SOURCE_CHAIN_ID
        ) revert InvalidConfiguration();

        retryVerifier = retryVerifier_;
        predicate = predicate_;
        chainInfo = IChainInfo(chainInfoOverride == address(0) ? CHAIN_INFO : chainInfoOverride);

        IChainInfo.ChainInfoResult memory source = chainInfo.get_chain_by_key(SOURCE_CHAIN_KEY);
        if (
            !source.exists || source.info.chainKey != SOURCE_CHAIN_KEY || source.info.chainId != SOURCE_CHAIN_ID
                || source.info.chainEncoding != 1
        ) revert InvalidSourceChain();
    }

    function createCampaign(
        SeaDropPaidRetryPredicateV1.Rule calldata rule,
        uint256 creditAmount,
        uint32 maxClaims,
        uint64 deadline
    ) external payable returns (uint256 campaignNumber) {
        if (creditAmount == 0 || maxClaims == 0) revert InvalidFunding();
        uint256 requiredFunding = creditAmount * uint256(maxClaims);
        if (msg.value != requiredFunding) revert InvalidFunding();
        if (deadline <= block.timestamp || deadline > block.timestamp + MAX_CAMPAIGN_DURATION) {
            revert InvalidDeadline();
        }

        predicate.validateTerms(rule);
        IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(SOURCE_CHAIN_KEY);
        if (!latest.exists || !latest.isAttestation || latest.height < rule.endBlock) {
            revert SourceWindowNotAttested();
        }

        campaignNumber = ++campaignCount;
        bytes32 termsHash = keccak256(
            abi.encode(
                "RETRYCREDIT_RECOVERY_CAMPAIGN_V1",
                block.chainid,
                address(this),
                campaignNumber,
                msg.sender,
                SOURCE_CHAIN_KEY,
                SOURCE_CHAIN_ID,
                rule,
                creditAmount,
                maxClaims,
                deadline
            )
        );
        campaigns[campaignNumber] = Campaign({
            sponsor: msg.sender,
            creditAmount: creditAmount,
            maxClaims: maxClaims,
            claimCount: 0,
            deadline: deadline,
            fundedAmount: requiredFunding,
            termsHash: termsHash,
            remainderRecovered: false
        });
        rules[campaignNumber] = rule;
        accountedBalance += requiredFunding;

        emit CampaignCreated(
            campaignNumber,
            msg.sender,
            rule.feeRecipient,
            creditAmount,
            maxClaims,
            deadline,
            rule.startBlock,
            rule.endBlock,
            termsHash
        );
    }

    function releaseCredit(uint256 campaignNumber, AttestcoinSeaDropRetryVerifier.BatchProof calldata proof)
        external
        nonReentrant
    {
        Campaign storage campaign = _campaign(campaignNumber);
        if (block.timestamp > campaign.deadline) revert CampaignClosed();
        if (campaign.claimCount >= campaign.maxClaims) revert CampaignFull();

        (address beneficiary, bytes32 actionId, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId) =
            retryVerifier.verifyRelease(proof, rules[campaignNumber]);
        if (beneficiary == address(0) || actionId == bytes32(0)) revert InvalidVerification();
        if (claimedByCampaign[campaignNumber][beneficiary]) revert AlreadyClaimed();
        if (
            consumedPairs[campaignNumber][pairId] || consumedQueries[campaignNumber][failureQueryId]
                || consumedQueries[campaignNumber][successQueryId]
        ) {
            revert Replay();
        }

        claimedByCampaign[campaignNumber][beneficiary] = true;
        consumedPairs[campaignNumber][pairId] = true;
        consumedQueries[campaignNumber][failureQueryId] = true;
        consumedQueries[campaignNumber][successQueryId] = true;
        unchecked {
            ++campaign.claimCount;
        }
        uint256 creditAmount = campaign.creditAmount;
        accountedBalance -= creditAmount;

        _send(beneficiary, creditAmount);
        emit CreditReleased(
            campaignNumber,
            beneficiary,
            actionId,
            creditAmount,
            failureQueryId,
            successQueryId,
            pairId,
            msg.sender,
            campaign.claimCount
        );
    }

    function recoverRemainder(uint256 campaignNumber) external nonReentrant {
        Campaign storage campaign = _campaign(campaignNumber);
        if (msg.sender != campaign.sponsor) revert NotSponsor();
        if (block.timestamp <= campaign.deadline) revert RecoveryClosed();
        if (campaign.remainderRecovered) revert AlreadyRecovered();

        campaign.remainderRecovered = true;
        uint256 remainder = campaign.creditAmount * uint256(campaign.maxClaims - campaign.claimCount);
        accountedBalance -= remainder;
        if (remainder != 0) _send(campaign.sponsor, remainder);
        emit RemainderRecovered(campaignNumber, campaign.sponsor, remainder);
    }

    function getCampaign(uint256 campaignNumber) external view returns (Campaign memory) {
        return _campaign(campaignNumber);
    }

    function getRule(uint256 campaignNumber) external view returns (SeaDropPaidRetryPredicateV1.Rule memory) {
        _campaign(campaignNumber);
        return rules[campaignNumber];
    }

    function remainingAccounted(uint256 campaignNumber) external view returns (uint256) {
        Campaign storage campaign = _campaign(campaignNumber);
        if (campaign.remainderRecovered) return 0;
        return campaign.creditAmount * uint256(campaign.maxClaims - campaign.claimCount);
    }

    function _campaign(uint256 campaignNumber) private view returns (Campaign storage campaign) {
        campaign = campaigns[campaignNumber];
        if (campaign.sponsor == address(0)) revert InvalidCampaign();
    }

    function _send(address recipient, uint256 amount) private {
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
