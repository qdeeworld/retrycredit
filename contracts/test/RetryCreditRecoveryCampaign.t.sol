// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinSeaDropRetryVerifier} from "../src/AttestcoinSeaDropRetryVerifier.sol";
import {RetryCreditRecoveryCampaign} from "../src/RetryCreditRecoveryCampaign.sol";
import {SeaDropPaidRetryPredicateV1} from "../src/SeaDropPaidRetryPredicateV1.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract ReentrantBeneficiary {
    address private target;
    bytes private payload;
    bool public attempted;
    bool public reentrySucceeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            (reentrySucceeded,) = target.call(payload);
        }
    }
}

contract RejectingBeneficiary {
    receive() external payable {
        revert("no credit");
    }
}

contract RetryCreditRecoveryCampaignTest is Test {
    uint64 private constant SOURCE_CHAIN_KEY = 3;
    uint64 private constant SOURCE_CHAIN_ID = 1;
    uint64 private constant START_BLOCK = 24_885_900;
    uint64 private constant END_BLOCK = START_BLOCK + 100;
    uint64 private constant FAILURE_BLOCK = START_BLOCK + 10;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 1;
    uint64 private constant FAILURE_NONCE = 246;

    uint256 private constant CREDIT_AMOUNT = 0.02 ether;
    uint256 private constant MINT_PRICE = 0.0003 ether;
    uint256 private constant SPONSOR_KEY = 0xA11CE;
    uint256 private constant BENEFICIARY_KEY = 0xB0B;
    uint256 private constant SECOND_BENEFICIARY_KEY = 0xCAFE;

    address private constant NFT = 0x6081B754134F988185b8c733A975C51c14e64cd7;
    address private constant FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address private constant RELAYER = address(0xC0DE);
    address private constant OUTSIDER = address(0xBAD);

    address private sponsor;
    address private beneficiary;
    address private secondBeneficiary;

    SeaDropPaidRetryPredicateV1 private predicate;
    MockNativeQueryVerifier private nativeVerifier;
    AttestcoinSeaDropRetryVerifier private retryVerifier;
    MockChainInfo private chainInfo;
    RetryCreditRecoveryCampaign private pool;

    function setUp() external {
        vm.chainId(13_374);
        vm.warp(1_800_000_000);
        sponsor = vm.addr(SPONSOR_KEY);
        beneficiary = vm.addr(BENEFICIARY_KEY);
        secondBeneficiary = vm.addr(SECOND_BENEFICIARY_KEY);

        predicate = new SeaDropPaidRetryPredicateV1();
        nativeVerifier = new MockNativeQueryVerifier();
        retryVerifier = new AttestcoinSeaDropRetryVerifier(predicate, address(nativeVerifier));
        chainInfo = new MockChainInfo(END_BLOCK);
        pool = new RetryCreditRecoveryCampaign(retryVerifier, address(chainInfo));

        vm.deal(sponsor, 20 ether);
        vm.deal(RELAYER, 1 ether);
        vm.deal(OUTSIDER, 1 ether);
    }

    function testAnyoneRelaysExactFixedCreditOnlyToProofDerivedSender() external {
        uint256 campaignNumber = _createCampaign(2);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        _setProofIndices(proof, 4, 9);

        uint256 beneficiaryBefore = beneficiary.balance;
        uint256 relayerBefore = RELAYER.balance;
        vm.prank(RELAYER);
        pool.releaseCredit(campaignNumber, proof);

        assertEq(beneficiary.balance - beneficiaryBefore, CREDIT_AMOUNT);
        assertEq(RELAYER.balance, relayerBefore);
        assertTrue(pool.claimedByCampaign(campaignNumber, beneficiary));
        assertFalse(pool.claimedByCampaign(campaignNumber, RELAYER));
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);
        assertEq(pool.remainingAccounted(campaignNumber), CREDIT_AMOUNT);

        RetryCreditRecoveryCampaign.Campaign memory campaign = pool.getCampaign(campaignNumber);
        assertEq(campaign.claimCount, 1);
        assertEq(campaign.maxClaims, 2);
        assertEq(campaign.fundedAmount, CREDIT_AMOUNT * 2);
        assertFalse(campaign.remainderRecovered);

        bytes32 failureQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, FAILURE_BLOCK, uint64(4)));
        bytes32 successQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, SUCCESS_BLOCK, uint64(9)));
        bytes32 actionId = _actionId(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE);
        bytes32 pairId = keccak256(
            abi.encode(
                retryVerifier.PAIR_DOMAIN(), SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, actionId, failureQueryId, successQueryId
            )
        );
        assertTrue(pool.consumedQueries(campaignNumber, failureQueryId));
        assertTrue(pool.consumedQueries(campaignNumber, successQueryId));
        assertTrue(pool.consumedPairs(campaignNumber, pairId));
        assertEq(nativeVerifier.batchCallCount(), 1);
        assertEq(nativeVerifier.lastBatchSize(), 2);
    }

    function testCampaignCreationIsImmutableExactlyFundedAndFullyAttested() external {
        SeaDropPaidRetryPredicateV1.Rule memory rule = _rule();
        uint64 deadline = uint64(block.timestamp + 7 days);

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidFunding.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT * 2 - 1}(rule, CREDIT_AMOUNT, 2, deadline);

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidFunding.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT * 2 + 1}(rule, CREDIT_AMOUNT, 2, deadline);

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidFunding.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: 0}(rule, 0, 2, deadline);

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidFunding.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: 0}(rule, CREDIT_AMOUNT, 0, deadline);

        uint256 campaignNumber = _createCampaign(2);
        RetryCreditRecoveryCampaign.Campaign memory campaign = pool.getCampaign(campaignNumber);
        SeaDropPaidRetryPredicateV1.Rule memory storedRule = pool.getRule(campaignNumber);
        assertEq(campaign.sponsor, sponsor);
        assertEq(campaign.creditAmount, CREDIT_AMOUNT);
        assertEq(campaign.maxClaims, 2);
        assertEq(campaign.deadline, deadline);
        assertNotEq(campaign.termsHash, bytes32(0));
        assertEq(storedRule.feeRecipient, rule.feeRecipient);
        assertEq(storedRule.startBlock, rule.startBlock);
        assertEq(storedRule.endBlock, rule.endBlock);
        assertEq(storedRule.maxBlockGap, rule.maxBlockGap);
        assertEq(storedRule.maxQuantity, rule.maxQuantity);
    }

    function testCreationRejectsUnattestedWindowAndInvalidDeadlines() external {
        SeaDropPaidRetryPredicateV1.Rule memory rule = _rule();

        chainInfo.setLatestAttestation(END_BLOCK - 1, true, true);
        _expectCreateRevert(RetryCreditRecoveryCampaign.SourceWindowNotAttested.selector, rule);
        chainInfo.setLatestAttestation(END_BLOCK, false, true);
        _expectCreateRevert(RetryCreditRecoveryCampaign.SourceWindowNotAttested.selector, rule);
        chainInfo.setLatestAttestation(END_BLOCK, true, false);
        _expectCreateRevert(RetryCreditRecoveryCampaign.SourceWindowNotAttested.selector, rule);
        chainInfo.setLatestAttestation(END_BLOCK, true, true);

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidDeadline.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT}(rule, CREDIT_AMOUNT, 1, uint64(block.timestamp));

        uint64 maximumDuration = pool.MAX_CAMPAIGN_DURATION();
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidDeadline.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT}(rule, CREDIT_AMOUNT, 1, uint64(block.timestamp + maximumDuration + 1));
    }

    function testConstructorRejectsWrongCreditcoinSourceIdentity() external {
        MockChainInfo wrong = new MockChainInfo(END_BLOCK);

        wrong.setSource(2, SOURCE_CHAIN_ID, 1, true);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidSourceChain.selector);
        new RetryCreditRecoveryCampaign(retryVerifier, address(wrong));

        wrong.setSource(SOURCE_CHAIN_KEY, 11_155_111, 1, true);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidSourceChain.selector);
        new RetryCreditRecoveryCampaign(retryVerifier, address(wrong));

        wrong.setSource(SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, 2, true);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidSourceChain.selector);
        new RetryCreditRecoveryCampaign(retryVerifier, address(wrong));

        wrong.setSource(SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, 1, false);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidSourceChain.selector);
        new RetryCreditRecoveryCampaign(retryVerifier, address(wrong));

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidConfiguration.selector);
        new RetryCreditRecoveryCampaign(AttestcoinSeaDropRetryVerifier(address(0)), address(wrong));

        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidConfiguration.selector);
        new RetryCreditRecoveryCampaign(AttestcoinSeaDropRetryVerifier(OUTSIDER), address(wrong));
    }

    function testVerifierHardBindsEthereumAndRejectsMalformedOrUnverifiedBatch() external {
        assertEq(retryVerifier.SOURCE_CHAIN_KEY(), SOURCE_CHAIN_KEY);
        assertEq(retryVerifier.SOURCE_CHAIN_ID(), SOURCE_CHAIN_ID);
        assertEq(retryVerifier.NATIVE_VERIFIER(), 0x0000000000000000000000000000000000000FD2);
        AttestcoinSeaDropRetryVerifier productionVerifier = new AttestcoinSeaDropRetryVerifier(predicate, address(0));
        assertEq(address(productionVerifier.verifier()), productionVerifier.NATIVE_VERIFIER());

        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        proof.sourceBlocks = new uint64[](1);
        vm.expectRevert(AttestcoinSeaDropRetryVerifier.InvalidBatch.selector);
        retryVerifier.verifyRelease(proof, _rule());

        proof = _proof(beneficiary, FAILURE_BLOCK, FAILURE_BLOCK, FAILURE_NONCE, 11, 12);
        vm.expectRevert(AttestcoinSeaDropRetryVerifier.InvalidProofOrder.selector);
        retryVerifier.verifyRelease(proof, _rule());

        proof = _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        nativeVerifier.setVerificationResult(false);
        vm.expectRevert(AttestcoinSeaDropRetryVerifier.ProofVerificationFailed.selector);
        retryVerifier.verifyRelease(proof, _rule());

        vm.expectRevert(AttestcoinSeaDropRetryVerifier.InvalidConfiguration.selector);
        new AttestcoinSeaDropRetryVerifier(SeaDropPaidRetryPredicateV1(address(0)), address(nativeVerifier));

        vm.expectRevert(AttestcoinSeaDropRetryVerifier.InvalidConfiguration.selector);
        new AttestcoinSeaDropRetryVerifier(SeaDropPaidRetryPredicateV1(OUTSIDER), address(nativeVerifier));
    }

    function testReplayIsCampaignScopedSoDustCampaignCannotPoisonOfficialCredit() external {
        AttestcoinSeaDropRetryVerifier.BatchProof memory first =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        uint256 firstCampaign = _createCampaign(2);
        vm.prank(RELAYER);
        pool.releaseCredit(firstCampaign, first);

        uint256 independentCampaign = _createCampaign(2);
        uint256 beneficiaryBefore = beneficiary.balance;
        vm.prank(OUTSIDER);
        pool.releaseCredit(independentCampaign, first);
        assertEq(beneficiary.balance - beneficiaryBefore, CREDIT_AMOUNT);
        assertEq(pool.getCampaign(firstCampaign).claimCount, 1);
        assertEq(pool.getCampaign(independentCampaign).claimCount, 1);

        AttestcoinSeaDropRetryVerifier.BatchProof memory senderFirst =
            _proof(beneficiary, FAILURE_BLOCK + 3, SUCCESS_BLOCK + 3, FAILURE_NONCE + 10, 21, 22);
        uint256 senderReplayCampaign = _createCampaign(2);
        pool.releaseCredit(senderReplayCampaign, senderFirst);

        AttestcoinSeaDropRetryVerifier.BatchProof memory senderSecond =
            _proof(beneficiary, FAILURE_BLOCK + 5, SUCCESS_BLOCK + 5, FAILURE_NONCE + 20, 31, 32);
        vm.expectRevert(RetryCreditRecoveryCampaign.AlreadyClaimed.selector);
        pool.releaseCredit(senderReplayCampaign, senderSecond);

        assertEq(pool.getCampaign(senderReplayCampaign).claimCount, 1);
        assertTrue(pool.claimedByCampaign(senderReplayCampaign, beneficiary));
    }

    function testCapacityStopsAdditionalProofBeforePayout() external {
        uint256 campaignNumber = _createCampaign(1);
        pool.releaseCredit(campaignNumber, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));

        uint256 secondBefore = secondBeneficiary.balance;
        AttestcoinSeaDropRetryVerifier.BatchProof memory secondProof =
            _proof(secondBeneficiary, FAILURE_BLOCK + 2, SUCCESS_BLOCK + 2, FAILURE_NONCE + 10, 21, 22);
        vm.expectRevert(RetryCreditRecoveryCampaign.CampaignFull.selector);
        pool.releaseCredit(campaignNumber, secondProof);
        assertEq(secondBeneficiary.balance, secondBefore);
        assertEq(pool.getCampaign(campaignNumber).claimCount, 1);
    }

    function testOnlySponsorRecoversExactAccountedRemainderAfterDeadline() external {
        uint256 campaignNumber = _createCampaign(3);
        pool.releaseCredit(campaignNumber, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        uint64 deadline = pool.getCampaign(campaignNumber).deadline;

        vm.expectRevert(RetryCreditRecoveryCampaign.NotSponsor.selector);
        vm.prank(OUTSIDER);
        pool.recoverRemainder(campaignNumber);

        vm.expectRevert(RetryCreditRecoveryCampaign.RecoveryClosed.selector);
        vm.prank(sponsor);
        pool.recoverRemainder(campaignNumber);

        vm.warp(deadline + 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory lateProof =
            _proof(secondBeneficiary, FAILURE_BLOCK + 2, SUCCESS_BLOCK + 2, FAILURE_NONCE + 10, 21, 22);
        vm.expectRevert(RetryCreditRecoveryCampaign.CampaignClosed.selector);
        pool.releaseCredit(campaignNumber, lateProof);

        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        pool.recoverRemainder(campaignNumber);
        assertEq(sponsor.balance - sponsorBefore, CREDIT_AMOUNT * 2);
        assertEq(pool.accountedBalance(), 0);
        assertEq(pool.remainingAccounted(campaignNumber), 0);
        assertTrue(pool.getCampaign(campaignNumber).remainderRecovered);

        vm.expectRevert(RetryCreditRecoveryCampaign.AlreadyRecovered.selector);
        vm.prank(sponsor);
        pool.recoverRemainder(campaignNumber);
    }

    function testForcedEtherIsNeverIncludedInCampaignRecovery() external {
        uint256 campaignNumber = _createCampaign(2);
        pool.releaseCredit(campaignNumber, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);

        // Model ETH forced into the contract without touching campaign accounting.
        vm.deal(address(pool), address(pool).balance + 1 ether);
        assertEq(address(pool).balance, 1 ether + CREDIT_AMOUNT);
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);

        vm.warp(pool.getCampaign(campaignNumber).deadline + 1);
        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        pool.recoverRemainder(campaignNumber);
        assertEq(sponsor.balance - sponsorBefore, CREDIT_AMOUNT);
        assertEq(pool.accountedBalance(), 0);
        assertEq(address(pool).balance, 1 ether);
    }

    function testThereIsNoEarlyCancelOrTopUpSurface() external {
        uint256 campaignNumber = _createCampaign(1);
        uint256 balanceBefore = address(pool).balance;

        vm.prank(sponsor);
        (bool cancelled,) = address(pool).call(abi.encodeWithSignature("cancelCampaign(uint256)", campaignNumber));
        assertFalse(cancelled);

        vm.prank(sponsor);
        (bool toppedUp,) =
            address(pool).call{value: CREDIT_AMOUNT}(abi.encodeWithSignature("topUpCampaign(uint256)", campaignNumber));
        assertFalse(toppedUp);
        assertEq(address(pool).balance, balanceBefore);
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);
    }

    function testReleaseIsEffectsBeforeInteractionAndNonReentrant() external {
        ReentrantBeneficiary recipient = new ReentrantBeneficiary();
        uint256 campaignNumber = _createCampaign(2);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(address(recipient), FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        recipient.arm(address(pool), abi.encodeCall(pool.releaseCredit, (campaignNumber, proof)));

        pool.releaseCredit(campaignNumber, proof);

        assertTrue(recipient.attempted());
        assertFalse(recipient.reentrySucceeded());
        assertEq(address(recipient).balance, CREDIT_AMOUNT);
        assertEq(pool.getCampaign(campaignNumber).claimCount, 1);
        assertTrue(pool.claimedByCampaign(campaignNumber, address(recipient)));
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);
    }

    function testRecipientTransferFailureRollsBackAllClaimEffects() external {
        RejectingBeneficiary recipient = new RejectingBeneficiary();
        uint256 campaignNumber = _createCampaign(1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(address(recipient), FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);

        vm.expectRevert(RetryCreditRecoveryCampaign.TransferFailed.selector);
        pool.releaseCredit(campaignNumber, proof);

        assertEq(pool.getCampaign(campaignNumber).claimCount, 0);
        assertFalse(pool.claimedByCampaign(campaignNumber, address(recipient)));
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT);
        assertEq(address(pool).balance, CREDIT_AMOUNT);
    }

    function testInvalidCampaignGettersAndActionsFailClosed() external {
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidCampaign.selector);
        pool.getCampaign(999);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidCampaign.selector);
        pool.getRule(999);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidCampaign.selector);
        pool.remainingAccounted(999);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidCampaign.selector);
        pool.releaseCredit(999, proof);
        vm.expectRevert(RetryCreditRecoveryCampaign.InvalidCampaign.selector);
        pool.recoverRemainder(999);
    }

    function _createCampaign(uint32 maxClaims) private returns (uint256 campaignNumber) {
        vm.prank(sponsor);
        campaignNumber = pool.createCampaign{value: CREDIT_AMOUNT * uint256(maxClaims)}(
            _rule(), CREDIT_AMOUNT, maxClaims, uint64(block.timestamp + 7 days)
        );
    }

    function _expectCreateRevert(bytes4 selector, SeaDropPaidRetryPredicateV1.Rule memory rule) private {
        vm.expectRevert(selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT}(rule, CREDIT_AMOUNT, 1, uint64(block.timestamp + 7 days));
    }

    function _rule() private pure returns (SeaDropPaidRetryPredicateV1.Rule memory rule) {
        rule = SeaDropPaidRetryPredicateV1.Rule({
            feeRecipient: FEE_RECIPIENT, startBlock: START_BLOCK, endBlock: END_BLOCK, maxBlockGap: 10, maxQuantity: 2
        });
    }

    function _proof(
        address sender,
        uint64 failureBlock,
        uint64 successBlock,
        uint64 failureNonce,
        uint256 failureSalt,
        uint256 successSalt
    ) private view returns (AttestcoinSeaDropRetryVerifier.BatchProof memory proof) {
        bytes memory failed = _encodedAttempt(sender, failureNonce, false, failureSalt, 516);
        bytes memory succeeded = _encodedAttempt(sender, failureNonce + 1, true, successSalt, 516);

        proof.sourceBlocks = new uint64[](2);
        proof.sourceBlocks[0] = failureBlock;
        proof.sourceBlocks[1] = successBlock;
        proof.encodedTransactions = new bytes[](2);
        proof.encodedTransactions[0] = failed;
        proof.encodedTransactions[1] = succeeded;
        proof.merkleProofs = new INativeQueryVerifier.MerkleProof[](2);
        proof.merkleProofs[0] = _merkleProof(keccak256(failed));
        proof.merkleProofs[1] = _merkleProof(keccak256(succeeded));
        proof.lowerEndpointDigest = bytes32(uint256(1));
        proof.continuityRoots = new bytes32[](0);
    }

    function _encodedAttempt(address sender, uint64 nonce, bool successful, uint256 salt, uint256 tokenId)
        private
        view
        returns (bytes memory)
    {
        SeaDropPaidRetryPredicateV1.MintParams memory mintParams = _mintParams();
        bytes memory signature = abi.encodePacked(bytes32(salt), bytes32(salt + 1), uint8(27));
        bytes memory callData = abi.encodeWithSelector(
            predicate.MINT_SIGNED_SELECTOR(), NFT, FEE_RECIPIENT, address(0), uint256(1), mintParams, salt, signature
        );
        bytes memory common =
            abi.encode(nonce, uint64(300_000), sender, false, predicate.SEADROP(), MINT_PRICE, callData);
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = _typeSpecific();
        chunks[2] = _receipt(sender, successful, tokenId, mintParams);
        return abi.encode(uint8(2), chunks);
    }

    function _receipt(
        address sender,
        bool successful,
        uint256 tokenId,
        SeaDropPaidRetryPredicateV1.MintParams memory mintParams
    ) private view returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](successful ? 2 : 0);
        if (successful) {
            bytes32[] memory seaDropTopics = new bytes32[](4);
            seaDropTopics[0] = predicate.SEADROP_MINT_EVENT();
            seaDropTopics[1] = bytes32(uint256(uint160(NFT)));
            seaDropTopics[2] = bytes32(uint256(uint160(sender)));
            seaDropTopics[3] = bytes32(uint256(uint160(FEE_RECIPIENT)));
            logs[0] = EvmV1Decoder.LogEntryTuple({
                address_: predicate.SEADROP(),
                topics: seaDropTopics,
                data: abi.encode(sender, uint256(1), MINT_PRICE, mintParams.feeBps, mintParams.dropStageIndex)
            });

            bytes32[] memory transferTopics = new bytes32[](4);
            transferTopics[0] = predicate.ERC721_TRANSFER_EVENT();
            transferTopics[1] = bytes32(0);
            transferTopics[2] = bytes32(uint256(uint160(sender)));
            transferTopics[3] = bytes32(tokenId);
            logs[1] = EvmV1Decoder.LogEntryTuple({address_: NFT, topics: transferTopics, data: bytes("")});
        }
        return abi.encode(successful ? uint8(1) : uint8(0), uint64(150_000), logs, new bytes(256));
    }

    function _mintParams() private pure returns (SeaDropPaidRetryPredicateV1.MintParams memory params) {
        params = SeaDropPaidRetryPredicateV1.MintParams({
            mintPrice: MINT_PRICE,
            maxTotalMintableByWallet: 1,
            startTime: 1_776_265_200,
            endTime: 1_776_268_800,
            dropStageIndex: 2,
            maxTokenSupplyForStage: 3_000,
            feeBps: 1_000,
            restrictFeeRecipients: true
        });
    }

    function _typeSpecific() private pure returns (bytes memory) {
        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        return abi.encode(
            SOURCE_CHAIN_ID,
            uint128(1_000_000_000),
            uint128(2_000_000_000),
            accessList,
            uint8(0),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
    }

    function _merkleProof(bytes32 root) private pure returns (INativeQueryVerifier.MerkleProof memory proof) {
        proof.root = root;
        proof.siblings = new INativeQueryVerifier.MerkleProofEntry[](0);
    }

    function _setProofIndices(
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof,
        uint64 failureIndex,
        uint64 successIndex
    ) private {
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[0].root, failureIndex);
        nativeVerifier.setTransactionIndexForRoot(proof.merkleProofs[1].root, successIndex);
    }

    function _actionId(address sender, uint64 failureBlock, uint64 successBlock, uint64 failureNonce)
        private
        pure
        returns (bytes32)
    {
        bytes32 semanticHash = keccak256(
            abi.encode(
                NFT,
                FEE_RECIPIENT,
                address(0),
                uint256(1),
                MINT_PRICE,
                uint256(1),
                uint256(1_776_265_200),
                uint256(1_776_268_800),
                uint256(2),
                uint256(3_000),
                uint256(1_000),
                true
            )
        );
        return keccak256(
            abi.encode(
                "RETRYCREDIT_SEADROP_PAID_RETRY_V1",
                SOURCE_CHAIN_ID,
                0x00005EA00Ac477B1030CE78506496e8C2dE24bf5,
                sender,
                failureBlock,
                successBlock,
                failureNonce,
                failureNonce + 1,
                semanticHash
            )
        );
    }
}
