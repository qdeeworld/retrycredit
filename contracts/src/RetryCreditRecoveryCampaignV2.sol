// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AttestcoinSeaDropRetryVerifier} from "./AttestcoinSeaDropRetryVerifier.sol";
import {RetryCreditRecoveryCampaign} from "./RetryCreditRecoveryCampaign.sol";
import {SeaDropPaidRetryPredicateV1} from "./SeaDropPaidRetryPredicateV1.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";

/// @notice A lineage-aware fixed-credit pool for already-attested Ethereum SeaDrop retries.
/// @dev V2 waits for its immutable V1 predecessor to close or fill, then rejects every wallet,
///      query, or pair consumed there. Within V2, replay protection follows the campaign sponsor
///      across all of that sponsor's campaigns so an unrelated dust-funded campaign cannot poison it.
contract RetryCreditRecoveryCampaignV2 is ReentrancyGuard {
    address public constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;
    uint64 public constant SOURCE_CHAIN_KEY = 3;
    uint64 public constant SOURCE_CHAIN_ID = 1;
    uint64 public constant MAX_CAMPAIGN_DURATION = 30 days;
    uint256 public constant LEGACY_CAMPAIGN_NUMBER = 1;

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

    struct InitialCampaign {
        SeaDropPaidRetryPredicateV1.Rule rule;
        uint256 creditAmount;
        uint32 maxClaims;
        uint64 deadline;
    }

    struct ReleaseIdentity {
        address beneficiary;
        bytes32 actionId;
        bytes32 failureQueryId;
        bytes32 successQueryId;
        bytes32 pairId;
    }

    AttestcoinSeaDropRetryVerifier public immutable retryVerifier;
    SeaDropPaidRetryPredicateV1 public immutable predicate;
    IChainInfo public immutable chainInfo;

    RetryCreditRecoveryCampaign public immutable legacyPool;
    address public immutable legacySponsor;
    bytes32 public immutable legacyTermsHash;
    bytes32 public immutable legacyBindingHash;
    uint64 public immutable legacyStartBlock;
    uint64 public immutable legacyEndBlock;
    uint64 public immutable legacyDeadline;

    uint256 public campaignCount;
    uint256 public accountedBalance;

    mapping(uint256 campaignNumber => Campaign) private campaigns;
    mapping(uint256 campaignNumber => SeaDropPaidRetryPredicateV1.Rule) private rules;

    // Retained for V1 ABI compatibility and exact per-campaign history.
    mapping(uint256 campaignNumber => mapping(address beneficiary => bool)) public claimedByCampaign;
    mapping(uint256 campaignNumber => mapping(bytes32 queryId => bool)) public consumedQueries;
    mapping(uint256 campaignNumber => mapping(bytes32 pairId => bool)) public consumedPairs;

    // V2 enforcement follows the campaign creator across all campaigns in this pool.
    mapping(address sponsor => mapping(address beneficiary => bool)) public claimedBySponsor;
    mapping(address sponsor => mapping(bytes32 queryId => bool)) public consumedQueriesBySponsor;
    mapping(address sponsor => mapping(bytes32 pairId => bool)) public consumedPairsBySponsor;

    event LegacyCampaignBound(
        address indexed legacyPool,
        uint256 indexed legacyCampaignNumber,
        address indexed sponsor,
        bytes32 termsHash,
        uint64 deadline,
        uint64 startBlock,
        uint64 endBlock
    );
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
    error InvalidLegacyBinding();
    error InvalidSourceChain();
    error InvalidVerification();
    error LegacyAlreadyClaimed();
    error LegacyCampaignStillOpen(uint64 deadline);
    error LegacyReplay();
    error NotSponsor();
    error RecoveryClosed();
    error Replay();
    error SourceWindowNotAttested();
    error TransferFailed();

    constructor(
        AttestcoinSeaDropRetryVerifier retryVerifier_,
        address chainInfoOverride,
        RetryCreditRecoveryCampaign legacyPool_,
        bytes32 expectedLegacyTermsHash,
        InitialCampaign memory initial
    ) payable {
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

        IChainInfo chainInfo_ = IChainInfo(chainInfoOverride == address(0) ? CHAIN_INFO : chainInfoOverride);
        IChainInfo.ChainInfoResult memory source = chainInfo_.get_chain_by_key(SOURCE_CHAIN_KEY);
        if (
            !source.exists || source.info.chainKey != SOURCE_CHAIN_KEY || source.info.chainId != SOURCE_CHAIN_ID
                || source.info.chainEncoding != 1
        ) revert InvalidSourceChain();

        if (
            address(legacyPool_) == address(0) || address(legacyPool_).code.length == 0
                || expectedLegacyTermsHash == bytes32(0) || legacyPool_.campaignCount() < LEGACY_CAMPAIGN_NUMBER
                || address(legacyPool_.retryVerifier()) != address(retryVerifier_)
                || address(legacyPool_.predicate()) != address(predicate_)
                || address(legacyPool_.chainInfo()) != address(chainInfo_)
                || legacyPool_.SOURCE_CHAIN_KEY() != SOURCE_CHAIN_KEY
                || legacyPool_.SOURCE_CHAIN_ID() != SOURCE_CHAIN_ID
        ) revert InvalidLegacyBinding();

        RetryCreditRecoveryCampaign.Campaign memory predecessor = legacyPool_.getCampaign(LEGACY_CAMPAIGN_NUMBER);
        if (
            predecessor.sponsor == address(0) || predecessor.sponsor != msg.sender || predecessor.creditAmount == 0
                || predecessor.maxClaims == 0 || predecessor.claimCount > predecessor.maxClaims
                || predecessor.creditAmount > type(uint256).max / uint256(predecessor.maxClaims)
                || predecessor.fundedAmount != predecessor.creditAmount * uint256(predecessor.maxClaims)
                || predecessor.termsHash != expectedLegacyTermsHash
        ) revert InvalidLegacyBinding();

        SeaDropPaidRetryPredicateV1.Rule memory predecessorRule = legacyPool_.getRule(LEGACY_CAMPAIGN_NUMBER);
        predicate_.validateTerms(predecessorRule);
        if (initial.rule.startBlock > predecessorRule.startBlock || initial.rule.endBlock < predecessorRule.endBlock) {
            revert InvalidLegacyBinding();
        }

        retryVerifier = retryVerifier_;
        predicate = predicate_;
        chainInfo = chainInfo_;
        legacyPool = legacyPool_;
        legacySponsor = predecessor.sponsor;
        legacyTermsHash = predecessor.termsHash;
        legacyStartBlock = predecessorRule.startBlock;
        legacyEndBlock = predecessorRule.endBlock;
        legacyDeadline = predecessor.deadline;
        legacyBindingHash = keccak256(
            abi.encode(
                address(legacyPool_),
                LEGACY_CAMPAIGN_NUMBER,
                predecessor.sponsor,
                predecessor.termsHash,
                predecessor.deadline,
                predecessorRule
            )
        );

        emit LegacyCampaignBound(
            address(legacyPool_),
            LEGACY_CAMPAIGN_NUMBER,
            predecessor.sponsor,
            predecessor.termsHash,
            predecessor.deadline,
            predecessorRule.startBlock,
            predecessorRule.endBlock
        );

        _createCampaign(initial.rule, initial.creditAmount, initial.maxClaims, initial.deadline, msg.sender, msg.value);
    }

    function createCampaign(
        SeaDropPaidRetryPredicateV1.Rule calldata rule,
        uint256 creditAmount,
        uint32 maxClaims,
        uint64 deadline
    ) external payable nonReentrant returns (uint256 campaignNumber) {
        return _createCampaign(rule, creditAmount, maxClaims, deadline, msg.sender, msg.value);
    }

    function releaseCredit(uint256 campaignNumber, AttestcoinSeaDropRetryVerifier.BatchProof calldata proof)
        external
        nonReentrant
    {
        Campaign storage campaign = _campaign(campaignNumber);
        if (block.timestamp > campaign.deadline) revert CampaignClosed();
        if (campaign.claimCount >= campaign.maxClaims) revert CampaignFull();
        if (!_legacyReleasesUnlocked()) revert LegacyCampaignStillOpen(legacyDeadline);

        ReleaseIdentity memory release = _verifyRelease(proof, rules[campaignNumber]);
        if (
            release.beneficiary == address(0) || release.actionId == bytes32(0) || release.failureQueryId == bytes32(0)
                || release.successQueryId == bytes32(0) || release.pairId == bytes32(0)
        ) revert InvalidVerification();

        if (
            legacyPool.consumedPairs(LEGACY_CAMPAIGN_NUMBER, release.pairId)
                || legacyPool.consumedQueries(LEGACY_CAMPAIGN_NUMBER, release.failureQueryId)
                || legacyPool.consumedQueries(LEGACY_CAMPAIGN_NUMBER, release.successQueryId)
        ) revert LegacyReplay();
        if (legacyPool.claimedByCampaign(LEGACY_CAMPAIGN_NUMBER, release.beneficiary)) {
            revert LegacyAlreadyClaimed();
        }

        address sponsor = campaign.sponsor;
        if (
            consumedPairsBySponsor[sponsor][release.pairId] || consumedQueriesBySponsor[sponsor][release.failureQueryId]
                || consumedQueriesBySponsor[sponsor][release.successQueryId]
        ) revert Replay();
        if (claimedBySponsor[sponsor][release.beneficiary]) revert AlreadyClaimed();

        _consumeRelease(campaignNumber, sponsor, release);
        unchecked {
            ++campaign.claimCount;
        }
        uint256 creditAmount = campaign.creditAmount;
        accountedBalance -= creditAmount;

        _send(release.beneficiary, creditAmount);
        _emitCreditReleased(campaignNumber, release, creditAmount, campaign.claimCount);
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

    function releasesUnlocked() external view returns (bool) {
        return _legacyReleasesUnlocked();
    }

    function _legacyReleasesUnlocked() private view returns (bool) {
        if (block.timestamp > legacyDeadline) return true;
        RetryCreditRecoveryCampaign.Campaign memory predecessor = legacyPool.getCampaign(LEGACY_CAMPAIGN_NUMBER);
        return predecessor.claimCount == predecessor.maxClaims;
    }

    function _verifyRelease(
        AttestcoinSeaDropRetryVerifier.BatchProof calldata proof,
        SeaDropPaidRetryPredicateV1.Rule storage rule
    ) private returns (ReleaseIdentity memory release) {
        (
            release.beneficiary, release.actionId, release.failureQueryId, release.successQueryId, release.pairId
        ) = retryVerifier.verifyRelease(proof, rule);
    }

    function _consumeRelease(uint256 campaignNumber, address sponsor, ReleaseIdentity memory release) private {
        claimedByCampaign[campaignNumber][release.beneficiary] = true;
        consumedPairs[campaignNumber][release.pairId] = true;
        consumedQueries[campaignNumber][release.failureQueryId] = true;
        consumedQueries[campaignNumber][release.successQueryId] = true;
        claimedBySponsor[sponsor][release.beneficiary] = true;
        consumedPairsBySponsor[sponsor][release.pairId] = true;
        consumedQueriesBySponsor[sponsor][release.failureQueryId] = true;
        consumedQueriesBySponsor[sponsor][release.successQueryId] = true;
    }

    function _emitCreditReleased(
        uint256 campaignNumber,
        ReleaseIdentity memory release,
        uint256 creditAmount,
        uint32 claimCount
    ) private {
        emit CreditReleased(
            campaignNumber,
            release.beneficiary,
            release.actionId,
            creditAmount,
            release.failureQueryId,
            release.successQueryId,
            release.pairId,
            msg.sender,
            claimCount
        );
    }

    function _createCampaign(
        SeaDropPaidRetryPredicateV1.Rule memory rule,
        uint256 creditAmount,
        uint32 maxClaims,
        uint64 deadline,
        address sponsor,
        uint256 funding
    ) private returns (uint256 campaignNumber) {
        if (creditAmount == 0 || maxClaims == 0 || creditAmount > type(uint256).max / uint256(maxClaims)) revert InvalidFunding();
        uint256 requiredFunding = creditAmount * uint256(maxClaims);
        if (funding != requiredFunding) revert InvalidFunding();
        if (
            deadline <= block.timestamp || deadline <= legacyDeadline
                || deadline > block.timestamp + MAX_CAMPAIGN_DURATION
        ) revert InvalidDeadline();

        predicate.validateTerms(rule);
        IChainInfo.HeightHashResult memory latest = chainInfo.get_latest_attestation_height_and_hash(SOURCE_CHAIN_KEY);
        if (!latest.exists || !latest.isAttestation || latest.height < rule.endBlock) {
            revert SourceWindowNotAttested();
        }

        campaignNumber = ++campaignCount;
        bytes32 termsHash = _campaignTermsHash(campaignNumber, sponsor, rule, creditAmount, maxClaims, deadline);
        campaigns[campaignNumber] = Campaign({
            sponsor: sponsor,
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

        _emitCampaignCreated(campaignNumber, rule);
    }

    function _emitCampaignCreated(uint256 campaignNumber, SeaDropPaidRetryPredicateV1.Rule memory rule) private {
        Campaign storage campaign = campaigns[campaignNumber];
        emit CampaignCreated(
            campaignNumber,
            campaign.sponsor,
            rule.feeRecipient,
            campaign.creditAmount,
            campaign.maxClaims,
            campaign.deadline,
            rule.startBlock,
            rule.endBlock,
            campaign.termsHash
        );
    }

    function _campaignTermsHash(
        uint256 campaignNumber,
        address sponsor,
        SeaDropPaidRetryPredicateV1.Rule memory rule,
        uint256 creditAmount,
        uint32 maxClaims,
        uint64 deadline
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                "RETRYCREDIT_RECOVERY_CAMPAIGN_V2",
                block.chainid,
                address(this),
                campaignNumber,
                sponsor,
                SOURCE_CHAIN_KEY,
                SOURCE_CHAIN_ID,
                legacyBindingHash,
                rule,
                creditAmount,
                maxClaims,
                deadline
            )
        );
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
