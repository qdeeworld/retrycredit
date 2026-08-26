// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {AttestcoinSeaDropRetryVerifier} from "../src/AttestcoinSeaDropRetryVerifier.sol";
import {RetryCreditRecoveryCampaign} from "../src/RetryCreditRecoveryCampaign.sol";
import {RetryCreditRecoveryCampaignV2} from "../src/RetryCreditRecoveryCampaignV2.sol";
import {SeaDropPaidRetryPredicateV1} from "../src/SeaDropPaidRetryPredicateV1.sol";
import {INativeQueryVerifier} from "../src/interfaces/INativeQueryVerifier.sol";
import {MockChainInfo} from "./mocks/MockChainInfo.sol";
import {MockNativeQueryVerifier} from "./mocks/MockNativeQueryVerifier.sol";

contract RejectingV2Beneficiary {
    receive() external payable {
        revert("no credit");
    }
}

contract ReentrantV2Beneficiary {
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

contract RetryCreditRecoveryCampaignV2Test is Test {
    uint64 private constant SOURCE_CHAIN_KEY = 3;
    uint64 private constant SOURCE_CHAIN_ID = 1;
    uint64 private constant SOURCE_START_BLOCK = 24_885_900;
    uint64 private constant SOURCE_END_BLOCK = SOURCE_START_BLOCK + 100;
    uint64 private constant LEGACY_START_BLOCK = SOURCE_START_BLOCK + 20;
    uint64 private constant LEGACY_END_BLOCK = SOURCE_END_BLOCK - 20;
    uint64 private constant FAILURE_BLOCK = LEGACY_START_BLOCK + 10;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 1;
    uint64 private constant FAILURE_NONCE = 246;

    uint64 private constant START_TIME = 1_780_000_000;
    uint64 private constant LEGACY_DEADLINE = START_TIME + 7 days;
    uint64 private constant V2_DEADLINE = START_TIME + 21 days;

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
    RetryCreditRecoveryCampaign private legacyPool;
    RetryCreditRecoveryCampaignV2 private pool;
    bytes32 private legacyTermsHash;

    function setUp() external {
        vm.chainId(13_374);
        vm.warp(START_TIME);
        sponsor = vm.addr(SPONSOR_KEY);
        beneficiary = vm.addr(BENEFICIARY_KEY);
        secondBeneficiary = vm.addr(SECOND_BENEFICIARY_KEY);

        predicate = new SeaDropPaidRetryPredicateV1();
        nativeVerifier = new MockNativeQueryVerifier();
        retryVerifier = new AttestcoinSeaDropRetryVerifier(predicate, address(nativeVerifier));
        chainInfo = new MockChainInfo(SOURCE_END_BLOCK);
        legacyPool = new RetryCreditRecoveryCampaign(retryVerifier, address(chainInfo));

        vm.deal(sponsor, 100 ether);
        vm.deal(OUTSIDER, 10 ether);
        vm.deal(RELAYER, 1 ether);

        vm.prank(sponsor);
        uint256 legacyCampaign =
            legacyPool.createCampaign{value: CREDIT_AMOUNT * 3}(_legacyRule(), CREDIT_AMOUNT, 3, LEGACY_DEADLINE);
        legacyTermsHash = legacyPool.getCampaign(legacyCampaign).termsHash;
        pool = _deployV2(CREDIT_AMOUNT * 3, legacyTermsHash, _initialCampaign(V2_DEADLINE, _v2Rule()));
    }

    function testConstructorBindsLegacyAndCreatesExactlyFundedInitialCampaign() external view {
        assertEq(address(pool.retryVerifier()), address(retryVerifier));
        assertEq(address(pool.predicate()), address(predicate));
        assertEq(address(pool.chainInfo()), address(chainInfo));
        assertEq(address(pool.legacyPool()), address(legacyPool));
        assertEq(pool.LEGACY_CAMPAIGN_NUMBER(), 1);
        assertEq(pool.legacySponsor(), sponsor);
        assertEq(pool.legacyTermsHash(), legacyTermsHash);
        assertEq(pool.legacyStartBlock(), LEGACY_START_BLOCK);
        assertEq(pool.legacyEndBlock(), LEGACY_END_BLOCK);
        assertEq(pool.legacyDeadline(), LEGACY_DEADLINE);
        assertFalse(pool.releasesUnlocked());

        bytes32 expectedBindingHash = keccak256(
            abi.encode(address(legacyPool), uint256(1), sponsor, legacyTermsHash, LEGACY_DEADLINE, _legacyRule())
        );
        assertEq(pool.legacyBindingHash(), expectedBindingHash);

        RetryCreditRecoveryCampaignV2.Campaign memory campaign = pool.getCampaign(1);
        assertEq(campaign.sponsor, sponsor);
        assertEq(campaign.creditAmount, CREDIT_AMOUNT);
        assertEq(campaign.maxClaims, 3);
        assertEq(campaign.claimCount, 0);
        assertEq(campaign.deadline, V2_DEADLINE);
        assertEq(campaign.fundedAmount, CREDIT_AMOUNT * 3);
        assertFalse(campaign.remainderRecovered);
        assertEq(pool.campaignCount(), 1);
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT * 3);
        assertEq(address(pool).balance, CREDIT_AMOUNT * 3);

        bytes32 expectedTermsHash = keccak256(
            abi.encode(
                "RETRYCREDIT_RECOVERY_CAMPAIGN_V2",
                block.chainid,
                address(pool),
                uint256(1),
                sponsor,
                SOURCE_CHAIN_KEY,
                SOURCE_CHAIN_ID,
                expectedBindingHash,
                _v2Rule(),
                CREDIT_AMOUNT,
                uint32(3),
                V2_DEADLINE
            )
        );
        assertEq(campaign.termsHash, expectedTermsHash);
    }

    function testStrictLegacyBoundaryLocksEveryProofThenCleanV2ReleaseSucceeds() external {
        AttestcoinSeaDropRetryVerifier.BatchProof memory outsideLegacyWindow =
            _proof(beneficiary, SOURCE_START_BLOCK + 2, SOURCE_START_BLOCK + 3, FAILURE_NONCE, 11, 12);

        vm.warp(LEGACY_DEADLINE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(RetryCreditRecoveryCampaignV2.LegacyCampaignStillOpen.selector, LEGACY_DEADLINE)
        );
        pool.releaseCredit(1, outsideLegacyWindow);
        assertEq(nativeVerifier.batchCallCount(), 0);

        vm.warp(LEGACY_DEADLINE);
        vm.expectRevert(
            abi.encodeWithSelector(RetryCreditRecoveryCampaignV2.LegacyCampaignStillOpen.selector, LEGACY_DEADLINE)
        );
        pool.releaseCredit(1, outsideLegacyWindow);
        assertEq(nativeVerifier.batchCallCount(), 0);

        vm.warp(LEGACY_DEADLINE + 1);
        assertTrue(pool.releasesUnlocked());
        uint256 beforeBalance = beneficiary.balance;
        vm.prank(RELAYER);
        pool.releaseCredit(1, outsideLegacyWindow);
        assertEq(beneficiary.balance - beforeBalance, CREDIT_AMOUNT);
        assertEq(nativeVerifier.batchCallCount(), 1);
        assertTrue(pool.claimedByCampaign(1, beneficiary));
        assertTrue(pool.claimedBySponsor(sponsor, beneficiary));
        assertEq(pool.getCampaign(1).claimCount, 1);
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT * 2);
    }

    function testLegacyCanReleaseAtExactDeadlineAndV2RejectsReplayAfterward() external {
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);

        vm.warp(LEGACY_DEADLINE);
        legacyPool.releaseCredit(1, proof);

        vm.warp(LEGACY_DEADLINE + 1);
        vm.expectRevert(RetryCreditRecoveryCampaign.CampaignClosed.selector);
        legacyPool.releaseCredit(1, proof);

        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyReplay.selector);
        pool.releaseCredit(1, proof);
        assertEq(pool.getCampaign(1).claimCount, 0);
        assertFalse(pool.claimedBySponsor(sponsor, beneficiary));
    }

    function testFinalLegacyClaimUnlocksV2InOrderAtTheSameTimestamp() external {
        address thirdBeneficiary = vm.addr(0xD00D);
        address fourthBeneficiary = vm.addr(0xF00D);
        AttestcoinSeaDropRetryVerifier.BatchProof memory finalLegacyProof =
            _proof(thirdBeneficiary, FAILURE_BLOCK + 6, SUCCESS_BLOCK + 6, FAILURE_NONCE + 20, 31, 32);
        AttestcoinSeaDropRetryVerifier.BatchProof memory cleanV2Proof =
            _proof(fourthBeneficiary, SOURCE_START_BLOCK + 2, SOURCE_START_BLOCK + 3, FAILURE_NONCE + 30, 41, 42);

        vm.warp(LEGACY_DEADLINE);
        legacyPool.releaseCredit(1, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        legacyPool.releaseCredit(
            1, _proof(secondBeneficiary, FAILURE_BLOCK + 3, SUCCESS_BLOCK + 3, FAILURE_NONCE + 10, 21, 22)
        );
        assertFalse(pool.releasesUnlocked());

        vm.expectRevert(
            abi.encodeWithSelector(RetryCreditRecoveryCampaignV2.LegacyCampaignStillOpen.selector, LEGACY_DEADLINE)
        );
        pool.releaseCredit(1, cleanV2Proof);

        legacyPool.releaseCredit(1, finalLegacyProof);
        assertTrue(pool.releasesUnlocked());
        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyReplay.selector);
        pool.releaseCredit(1, finalLegacyProof);

        uint256 beforeBalance = fourthBeneficiary.balance;
        pool.releaseCredit(1, cleanV2Proof);
        assertEq(fourthBeneficiary.balance - beforeBalance, CREDIT_AMOUNT);
        assertEq(pool.getCampaign(1).claimCount, 1);
    }

    function testDistinctPairFromLegacyPaidWalletIsRejected() external {
        vm.warp(LEGACY_DEADLINE);
        legacyPool.releaseCredit(1, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));

        vm.warp(LEGACY_DEADLINE + 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory distinct =
            _proof(beneficiary, FAILURE_BLOCK + 3, SUCCESS_BLOCK + 3, FAILURE_NONCE + 10, 21, 22);
        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyAlreadyClaimed.selector);
        pool.releaseCredit(1, distinct);
    }

    function testEveryLegacyReplayFlagClassFailsClosed() external {
        vm.warp(LEGACY_DEADLINE + 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        (bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId) =
            _replayIds(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE);

        vm.mockCall(
            address(legacyPool), abi.encodeCall(legacyPool.consumedPairs, (uint256(1), pairId)), abi.encode(true)
        );
        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyReplay.selector);
        pool.releaseCredit(1, proof);
        vm.clearMockedCalls();

        vm.mockCall(
            address(legacyPool),
            abi.encodeCall(legacyPool.consumedQueries, (uint256(1), failureQueryId)),
            abi.encode(true)
        );
        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyReplay.selector);
        pool.releaseCredit(1, proof);
        vm.clearMockedCalls();

        vm.mockCall(
            address(legacyPool),
            abi.encodeCall(legacyPool.consumedQueries, (uint256(1), successQueryId)),
            abi.encode(true)
        );
        vm.expectRevert(RetryCreditRecoveryCampaignV2.LegacyReplay.selector);
        pool.releaseCredit(1, proof);
        vm.clearMockedCalls();

        assertEq(pool.getCampaign(1).claimCount, 0);
        assertEq(nativeVerifier.batchCallCount(), 0);
    }

    function testLegacyReadFailureFailsClosedWithoutEffects() external {
        vm.warp(LEGACY_DEADLINE + 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        (,, bytes32 pairId) = _replayIds(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE);
        vm.mockCallRevert(
            address(legacyPool),
            abi.encodeCall(legacyPool.consumedPairs, (uint256(1), pairId)),
            abi.encodeWithSignature("Error(string)", "legacy unavailable")
        );

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "legacy unavailable"));
        pool.releaseCredit(1, proof);
        assertEq(pool.getCampaign(1).claimCount, 0);
        assertFalse(pool.claimedBySponsor(sponsor, beneficiary));
    }

    function testSponsorLineageRejectsSamePairAcrossCampaigns() external {
        vm.warp(LEGACY_DEADLINE + 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        pool.releaseCredit(1, proof);
        uint256 second = _createCampaignFor(sponsor, CREDIT_AMOUNT, 2);

        vm.expectRevert(RetryCreditRecoveryCampaignV2.Replay.selector);
        pool.releaseCredit(second, proof);
        assertFalse(pool.claimedByCampaign(second, beneficiary));
    }

    function testSponsorLineageRejectsDistinctPairFromSameWallet() external {
        vm.warp(LEGACY_DEADLINE + 1);
        pool.releaseCredit(1, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        uint256 second = _createCampaignFor(sponsor, CREDIT_AMOUNT, 2);

        AttestcoinSeaDropRetryVerifier.BatchProof memory distinct =
            _proof(beneficiary, FAILURE_BLOCK + 3, SUCCESS_BLOCK + 3, FAILURE_NONCE + 10, 21, 22);
        vm.expectRevert(RetryCreditRecoveryCampaignV2.AlreadyClaimed.selector);
        pool.releaseCredit(second, distinct);
    }

    function testSponsorLineageRejectsSharedQueryEvenForDifferentWallet() external {
        vm.warp(LEGACY_DEADLINE + 1);
        pool.releaseCredit(1, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        uint256 second = _createCampaignFor(sponsor, CREDIT_AMOUNT, 2);

        // Same source blocks and mock-native transaction indexes produce the same query IDs,
        // while the different sender and nonce make the action and pair IDs distinct.
        AttestcoinSeaDropRetryVerifier.BatchProof memory sharedQuery =
            _proof(secondBeneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE + 50, 31, 32);
        vm.expectRevert(RetryCreditRecoveryCampaignV2.Replay.selector);
        pool.releaseCredit(second, sharedQuery);
        assertFalse(pool.claimedBySponsor(sponsor, secondBeneficiary));
    }

    function testOutsiderDustCampaignCannotPoisonOfficialSponsorLineage() external {
        vm.warp(LEGACY_DEADLINE + 1);
        uint256 dustCampaign = _createCampaignFor(OUTSIDER, 1, 1);
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);

        uint256 beforeBalance = beneficiary.balance;
        vm.prank(OUTSIDER);
        pool.releaseCredit(dustCampaign, proof);
        assertEq(beneficiary.balance - beforeBalance, 1);
        assertTrue(pool.claimedBySponsor(OUTSIDER, beneficiary));
        assertFalse(pool.claimedBySponsor(sponsor, beneficiary));

        vm.prank(RELAYER);
        pool.releaseCredit(1, proof);
        assertEq(beneficiary.balance - beforeBalance, CREDIT_AMOUNT + 1);
        assertTrue(pool.claimedBySponsor(sponsor, beneficiary));
        assertTrue(pool.claimedByCampaign(1, beneficiary));
        assertTrue(pool.claimedByCampaign(dustCampaign, beneficiary));
    }

    function testConstructorRejectsWrongLegacyBindingFundingDeadlineAndWindow() external {
        RetryCreditRecoveryCampaignV2.InitialCampaign memory initial = _initialCampaign(V2_DEADLINE, _v2Rule());

        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidLegacyBinding.selector);
        vm.prank(sponsor);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3}(
            retryVerifier, address(chainInfo), legacyPool, bytes32(uint256(1)), initial
        );

        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidLegacyBinding.selector);
        vm.prank(OUTSIDER);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3}(
            retryVerifier, address(chainInfo), legacyPool, legacyTermsHash, initial
        );

        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidFunding.selector);
        vm.prank(sponsor);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3 - 1}(
            retryVerifier, address(chainInfo), legacyPool, legacyTermsHash, initial
        );

        initial.deadline = LEGACY_DEADLINE;
        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidDeadline.selector);
        vm.prank(sponsor);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3}(
            retryVerifier, address(chainInfo), legacyPool, legacyTermsHash, initial
        );

        initial = _initialCampaign(V2_DEADLINE, _v2Rule());
        initial.rule.startBlock = LEGACY_START_BLOCK + 1;
        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidLegacyBinding.selector);
        vm.prank(sponsor);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3}(
            retryVerifier, address(chainInfo), legacyPool, legacyTermsHash, initial
        );

        initial = _initialCampaign(V2_DEADLINE, _v2Rule());
        initial.rule.endBlock = LEGACY_END_BLOCK - 1;
        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidLegacyBinding.selector);
        vm.prank(sponsor);
        new RetryCreditRecoveryCampaignV2{value: CREDIT_AMOUNT * 3}(
            retryVerifier, address(chainInfo), legacyPool, legacyTermsHash, initial
        );
    }

    function testLaterCampaignCreationRemainsExactFundedAttestedAndBounded() external {
        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidFunding.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT - 1}(_v2Rule(), CREDIT_AMOUNT, 1, V2_DEADLINE);

        vm.expectRevert(RetryCreditRecoveryCampaignV2.InvalidDeadline.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT}(_v2Rule(), CREDIT_AMOUNT, 1, LEGACY_DEADLINE);

        chainInfo.setLatestAttestation(SOURCE_END_BLOCK - 1, true, true);
        vm.expectRevert(RetryCreditRecoveryCampaignV2.SourceWindowNotAttested.selector);
        vm.prank(sponsor);
        pool.createCampaign{value: CREDIT_AMOUNT}(_v2Rule(), CREDIT_AMOUNT, 1, V2_DEADLINE);
        chainInfo.setLatestAttestation(SOURCE_END_BLOCK, true, true);

        uint256 campaignNumber = _createCampaignFor(sponsor, CREDIT_AMOUNT, 1);
        assertEq(campaignNumber, 2);
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT * 4);
    }

    function testPredeployAndPostdeployForcedEtherNeverEntersAccountingOrRecovery() external {
        uint256 funding = CREDIT_AMOUNT * 3;
        uint256 nextNonce = vm.getNonce(sponsor);
        address predicted = vm.computeCreateAddress(sponsor, nextNonce);
        vm.deal(predicted, 1 ether);

        RetryCreditRecoveryCampaignV2 prefunded =
            _deployV2(funding, legacyTermsHash, _initialCampaign(V2_DEADLINE, _v2Rule()));
        assertEq(address(prefunded), predicted);
        assertEq(prefunded.accountedBalance(), funding);
        assertEq(address(prefunded).balance, funding + 1 ether);

        vm.deal(address(prefunded), address(prefunded).balance + 2 ether);
        assertEq(prefunded.accountedBalance(), funding);
        vm.warp(V2_DEADLINE + 1);
        uint256 sponsorBefore = sponsor.balance;
        vm.prank(sponsor);
        prefunded.recoverRemainder(1);
        assertEq(sponsor.balance - sponsorBefore, funding);
        assertEq(prefunded.accountedBalance(), 0);
        assertEq(address(prefunded).balance, 3 ether);
    }

    function testRejectingBeneficiaryRollsBackCampaignAndSponsorEffects() external {
        vm.warp(LEGACY_DEADLINE + 1);
        RejectingV2Beneficiary recipient = new RejectingV2Beneficiary();
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(address(recipient), FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);

        vm.expectRevert(RetryCreditRecoveryCampaignV2.TransferFailed.selector);
        pool.releaseCredit(1, proof);
        assertEq(pool.getCampaign(1).claimCount, 0);
        assertFalse(pool.claimedByCampaign(1, address(recipient)));
        assertFalse(pool.claimedBySponsor(sponsor, address(recipient)));
        assertEq(pool.accountedBalance(), CREDIT_AMOUNT * 3);
        assertEq(address(pool).balance, CREDIT_AMOUNT * 3);
    }

    function testReleaseIsEffectsBeforeInteractionAndNonReentrantAcrossLineage() external {
        vm.warp(LEGACY_DEADLINE + 1);
        ReentrantV2Beneficiary recipient = new ReentrantV2Beneficiary();
        AttestcoinSeaDropRetryVerifier.BatchProof memory proof =
            _proof(address(recipient), FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12);
        recipient.arm(address(pool), abi.encodeCall(pool.releaseCredit, (uint256(1), proof)));

        pool.releaseCredit(1, proof);
        assertTrue(recipient.attempted());
        assertFalse(recipient.reentrySucceeded());
        assertEq(address(recipient).balance, CREDIT_AMOUNT);
        assertTrue(pool.claimedByCampaign(1, address(recipient)));
        assertTrue(pool.claimedBySponsor(sponsor, address(recipient)));
        assertEq(pool.getCampaign(1).claimCount, 1);
    }

    function testExactAccountedRemainderAndForcedDustInvariantAcrossCampaigns() external {
        vm.warp(LEGACY_DEADLINE + 1);
        uint256 second = _createCampaignFor(OUTSIDER, CREDIT_AMOUNT, 2);
        pool.releaseCredit(1, _proof(beneficiary, FAILURE_BLOCK, SUCCESS_BLOCK, FAILURE_NONCE, 11, 12));
        vm.prank(RELAYER);
        pool.releaseCredit(
            second, _proof(secondBeneficiary, FAILURE_BLOCK + 3, SUCCESS_BLOCK + 3, FAILURE_NONCE + 10, 21, 22)
        );
        vm.deal(address(pool), address(pool).balance + 1 ether);

        uint256 expectedAccounted = pool.remainingAccounted(1) + pool.remainingAccounted(second);
        assertEq(pool.accountedBalance(), expectedAccounted);
        assertGe(address(pool).balance, pool.accountedBalance());

        vm.warp(V2_DEADLINE + 1);
        vm.prank(sponsor);
        pool.recoverRemainder(1);
        vm.prank(OUTSIDER);
        pool.recoverRemainder(second);
        assertEq(pool.accountedBalance(), 0);
        assertEq(address(pool).balance, 1 ether);
    }

    function _deployV2(
        uint256 funding,
        bytes32 expectedLegacyHash,
        RetryCreditRecoveryCampaignV2.InitialCampaign memory initial
    ) private returns (RetryCreditRecoveryCampaignV2 deployed) {
        vm.prank(sponsor);
        deployed = new RetryCreditRecoveryCampaignV2{value: funding}(
            retryVerifier, address(chainInfo), legacyPool, expectedLegacyHash, initial
        );
    }

    function _createCampaignFor(address campaignSponsor, uint256 creditAmount, uint32 maxClaims)
        private
        returns (uint256 campaignNumber)
    {
        vm.prank(campaignSponsor);
        campaignNumber = pool.createCampaign{value: creditAmount * uint256(maxClaims)}(
            _v2Rule(), creditAmount, maxClaims, V2_DEADLINE
        );
    }

    function _initialCampaign(uint64 deadline, SeaDropPaidRetryPredicateV1.Rule memory rule)
        private
        pure
        returns (RetryCreditRecoveryCampaignV2.InitialCampaign memory initial)
    {
        initial = RetryCreditRecoveryCampaignV2.InitialCampaign({
            rule: rule, creditAmount: CREDIT_AMOUNT, maxClaims: 3, deadline: deadline
        });
    }

    function _legacyRule() private pure returns (SeaDropPaidRetryPredicateV1.Rule memory rule) {
        rule = SeaDropPaidRetryPredicateV1.Rule({
            feeRecipient: FEE_RECIPIENT,
            startBlock: LEGACY_START_BLOCK,
            endBlock: LEGACY_END_BLOCK,
            maxBlockGap: 10,
            maxQuantity: 2
        });
    }

    function _v2Rule() private pure returns (SeaDropPaidRetryPredicateV1.Rule memory rule) {
        rule = SeaDropPaidRetryPredicateV1.Rule({
            feeRecipient: FEE_RECIPIENT,
            startBlock: SOURCE_START_BLOCK,
            endBlock: SOURCE_END_BLOCK,
            maxBlockGap: 10,
            maxQuantity: 2
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

    function _replayIds(address sender, uint64 failureBlock, uint64 successBlock, uint64 failureNonce)
        private
        view
        returns (bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId)
    {
        uint64 index = nativeVerifier.transactionIndex();
        failureQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, failureBlock, index));
        successQueryId = keccak256(abi.encode(SOURCE_CHAIN_KEY, successBlock, index));
        bytes32 actionId = _actionId(sender, failureBlock, successBlock, failureNonce);
        pairId = keccak256(
            abi.encode(
                retryVerifier.PAIR_DOMAIN(), SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, actionId, failureQueryId, successQueryId
            )
        );
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
