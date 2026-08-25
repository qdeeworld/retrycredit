// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {SeaDropPaidRetryPredicateV1} from "../src/SeaDropPaidRetryPredicateV1.sol";

contract SeaDropPaidRetryPredicateV1Test is Test {
    uint64 private constant START_BLOCK = 25_800_000;
    uint64 private constant END_BLOCK = START_BLOCK + 1_000;
    uint64 private constant FAILURE_BLOCK = START_BLOCK + 100;
    uint64 private constant SUCCESS_BLOCK = FAILURE_BLOCK + 2;
    uint64 private constant FAILURE_NONCE = 246;
    uint256 private constant MINT_PRICE = 0.005 ether;
    bytes4 private constant MINT_SIGNED_SELECTOR = 0x4b61cd6f;
    bytes4 private constant OPENSEA_ATTRIBUTION_SUFFIX = 0x3d958fe2;

    address private constant SENDER = 0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF;
    address private constant OTHER_SENDER = address(0xB0B);
    address private constant NFT = 0x6081B754134F988185b8c733A975C51c14e64cd7;
    address private constant OTHER_NFT = address(0xBEEF);
    address private constant FEE_RECIPIENT = 0x0000a26b00c1F0DF003000390027140000fAa719;
    address private constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;

    struct CallSpec {
        address nftContract;
        address feeRecipient;
        address minterIfNotPayer;
        uint256 quantity;
        SeaDropPaidRetryPredicateV1.MintParams mintParams;
        uint256 salt;
        bytes signature;
    }

    SeaDropPaidRetryPredicateV1 private predicate;

    function setUp() external {
        predicate = new SeaDropPaidRetryPredicateV1();
    }

    function testValidPaidRetryReturnsSourceSenderAndPairLocalAction() external view {
        CallSpec memory failedCall = _call(false);
        CallSpec memory successfulCall = _call(true);
        (address beneficiary, bytes32 actionId) = predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(successfulCall),
            SUCCESS_BLOCK,
            1,
            _rule()
        );

        assertEq(beneficiary, SENDER);
        assertTrue(actionId != bytes32(0));

        (, bytes32 sameActionId) = predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(successfulCall),
            SUCCESS_BLOCK,
            1,
            _rule()
        );
        assertEq(actionId, sameActionId);

        (, bytes32 laterPairActionId) = predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK + 1,
            _successfulTransaction(successfulCall),
            SUCCESS_BLOCK + 1,
            1,
            _rule()
        );
        assertTrue(actionId != laterPairActionId);
    }

    function testValidRetryMayReuseSaltAndSignatureUnchanged() external view {
        CallSpec memory failedCall = _call(false);
        CallSpec memory successfulCall = _call(false);

        (address beneficiary, bytes32 actionId) = predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(successfulCall),
            SUCCESS_BLOCK,
            1,
            _rule()
        );

        assertEq(beneficiary, SENDER);
        assertTrue(actionId != bytes32(0));
    }

    function testAcceptsOnlyExactOpenSeaAttributionSuffixWithoutChangingActionIdentity() external view {
        CallSpec memory failedCall = _call(false);
        CallSpec memory successfulCall = _call(true);
        assertEq(_calldata(failedCall).length, 580);
        assertEq(_attributedCalldata(failedCall).length, 584);
        bytes memory attributedFailure = _encodedTransaction(
            _attributedCalldata(failedCall), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1
        );
        bytes memory attributedSuccess = _encodedTransaction(
            _attributedCalldata(successfulCall),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(successfulCall, SENDER),
            2,
            1
        );

        (address beneficiary, bytes32 attributedActionId) =
            predicate.validate(attributedFailure, FAILURE_BLOCK, attributedSuccess, SUCCESS_BLOCK, 1, _rule());
        (, bytes32 canonicalActionId) = predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(successfulCall),
            SUCCESS_BLOCK,
            1,
            _rule()
        );
        // Each attempt is independently allowed to use canonical or exactly attributed calldata.
        predicate.validate(_failedTransaction(failedCall), FAILURE_BLOCK, attributedSuccess, SUCCESS_BLOCK, 1, _rule());

        assertEq(beneficiary, SENDER);
        assertEq(attributedActionId, canonicalActionId);
    }

    function testValidateTermsRejectsInvalidRules() external {
        SeaDropPaidRetryPredicateV1.Rule memory rule = _rule();
        predicate.validateTerms(rule);

        rule.feeRecipient = address(0);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidRule.selector);
        predicate.validateTerms(rule);

        rule = _rule();
        rule.endBlock = rule.startBlock;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidRule.selector);
        predicate.validateTerms(rule);

        rule = _rule();
        rule.maxBlockGap = 0;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidRule.selector);
        predicate.validateTerms(rule);

        rule = _rule();
        rule.maxBlockGap = 1_001;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidRule.selector);
        predicate.validateTerms(rule);

        rule = _rule();
        rule.maxQuantity = 0;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidRule.selector);
        predicate.validateTerms(rule);
    }

    function testRejectsWrongExternalOrEncodedSourceChain() external {
        bytes memory failed = _failedTransaction(_call(false));
        bytes memory successful = _successfulTransaction(_call(true));

        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceChain.selector);
        predicate.validate(failed, FAILURE_BLOCK, successful, SUCCESS_BLOCK, 11_155_111, _rule());

        failed = _encodedTransaction(
            _calldata(_call(false)), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 10
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceChain.selector);
        predicate.validate(failed, FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, _rule());

        successful = _encodedTransaction(
            _calldata(_call(true)),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(_call(true), SENDER),
            2,
            10
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceChain.selector);
        predicate.validate(_failedTransaction(_call(false)), FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsNonTypeTwoTransactionOnEitherSide() external {
        bytes memory failed = _encodedTransaction(
            _calldata(_call(false)), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 1, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceTransaction.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory successful = _encodedTransaction(
            _calldata(_call(true)),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(_call(true), SENDER),
            3,
            1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceTransaction.selector);
        predicate.validate(_failedTransaction(_call(false)), FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsTransactionsOutsideWindowOrOrderOrGap() external {
        bytes memory failed = _failedTransaction(_call(false));
        bytes memory successful = _successfulTransaction(_call(true));

        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceBlock.selector);
        predicate.validate(failed, START_BLOCK - 1, successful, SUCCESS_BLOCK, 1, _rule());

        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceBlock.selector);
        predicate.validate(failed, FAILURE_BLOCK, successful, END_BLOCK + 1, 1, _rule());

        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSourceBlock.selector);
        predicate.validate(failed, FAILURE_BLOCK, successful, FAILURE_BLOCK, 1, _rule());

        SeaDropPaidRetryPredicateV1.Rule memory tightRule = _rule();
        tightRule.maxBlockGap = 1;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidBlockGap.selector);
        predicate.validate(failed, FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, tightRule);
    }

    function testRejectsZeroOrDifferentSourceSender() external {
        CallSpec memory failedCall = _call(false);
        CallSpec memory successfulCall = _call(true);
        bytes memory failed = _encodedTransaction(
            _calldata(failedCall), FAILURE_NONCE, address(0), false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidParticipant.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(successfulCall), SUCCESS_BLOCK, 1, _rule());

        bytes memory successful = _encodedTransaction(
            _calldata(successfulCall),
            FAILURE_NONCE + 1,
            OTHER_SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(successfulCall, OTHER_SENDER),
            2,
            1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidParticipant.selector);
        predicate.validate(_failedTransaction(failedCall), FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsWrongTargetOrContractCreation() external {
        CallSpec memory failedCall = _call(false);
        bytes memory wrongTarget = _encodedTransaction(
            _calldata(failedCall), FAILURE_NONCE, SENDER, false, address(0xBAD), MINT_PRICE, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidTarget.selector);
        predicate.validate(wrongTarget, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory creation = _encodedTransaction(
            _calldata(failedCall), FAILURE_NONCE, SENDER, true, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidTarget.selector);
        predicate.validate(creation, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());
    }

    function testRequiresExactlyConsecutiveNonces() external {
        CallSpec memory successfulCall = _call(true);
        bytes memory skippedNonce = _encodedTransaction(
            _calldata(successfulCall),
            FAILURE_NONCE + 2,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(successfulCall, SENDER),
            2,
            1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidNonceSequence.selector);
        predicate.validate(_failedTransaction(_call(false)), FAILURE_BLOCK, skippedNonce, SUCCESS_BLOCK, 1, _rule());

        bytes memory sameNonce = _encodedTransaction(
            _calldata(successfulCall),
            FAILURE_NONCE,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            1,
            _successLogs(successfulCall, SENDER),
            2,
            1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidNonceSequence.selector);
        predicate.validate(_failedTransaction(_call(false)), FAILURE_BLOCK, sameNonce, SUCCESS_BLOCK, 1, _rule());
    }

    function testRequiresFailedThenSuccessfulReceiptAndNoFailureLogs() external {
        CallSpec memory failedCall = _call(false);
        bytes memory statusOneFailure = _encodedTransaction(
            _calldata(failedCall), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 1, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidReceiptSequence.selector);
        predicate.validate(
            statusOneFailure, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule()
        );

        EvmV1Decoder.LogEntryTuple[] memory failureLogs = new EvmV1Decoder.LogEntryTuple[](1);
        failureLogs[0] = _seaDropMintLog(failedCall, SENDER);
        bytes memory loggedFailure = _encodedTransaction(
            _calldata(failedCall), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, failureLogs, 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidReceiptSequence.selector);
        predicate.validate(loggedFailure, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        CallSpec memory successfulCall = _call(true);
        bytes memory statusZeroSuccess = _encodedTransaction(
            _calldata(successfulCall),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            MINT_PRICE,
            0,
            _successLogs(successfulCall, SENDER),
            2,
            1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidReceiptSequence.selector);
        predicate.validate(_failedTransaction(failedCall), FAILURE_BLOCK, statusZeroSuccess, SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsWrongSelectorAndTrailingOrNoncanonicalCalldata() external {
        bytes memory wrongSelector = _calldata(_call(false));
        wrongSelector[0] = 0xff;
        bytes memory failed =
            _encodedTransaction(wrongSelector, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory trailing = bytes.concat(_calldata(_call(false)), hex"00");
        failed = _encodedTransaction(trailing, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory noncanonical = _calldata(_call(false));
        // The final head word is the signature offset. Point it 32 bytes later and append a valid dynamic body.
        assembly ("memory-safe") {
            mstore(add(add(noncanonical, 0x20), 420), 480)
        }
        noncanonical = bytes.concat(noncanonical, new bytes(32));
        failed =
            _encodedTransaction(noncanonical, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1);
        vm.expectRevert();
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsMutatedOrWrongLengthOpenSeaAttributionSuffix() external {
        bytes memory mutatedMarker = bytes.concat(_calldata(_call(false)), hex"3d958fe3");
        bytes memory failed =
            _encodedTransaction(mutatedMarker, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory markerPlusTrailingByte =
            bytes.concat(_calldata(_call(false)), abi.encodePacked(OPENSEA_ATTRIBUTION_SUFFIX), hex"00");
        failed = _encodedTransaction(
            markerPlusTrailingByte, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        bytes memory repeatedMarker = bytes.concat(
            _calldata(_call(false)),
            abi.encodePacked(OPENSEA_ATTRIBUTION_SUFFIX),
            abi.encodePacked(OPENSEA_ATTRIBUTION_SUFFIX)
        );
        failed =
            _encodedTransaction(repeatedMarker, FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidCalldata.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());
    }

    function testRejectsWrongFeeRecipientOrNonzeroMinter() external {
        CallSpec memory failedCall = _call(false);
        failedCall.feeRecipient = address(0xFEE);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidFeeRecipient.selector);
        predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(_call(true)),
            SUCCESS_BLOCK,
            1,
            _rule()
        );

        failedCall = _call(false);
        failedCall.minterIfNotPayer = SENDER;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidMinter.selector);
        predicate.validate(
            _failedTransaction(failedCall),
            FAILURE_BLOCK,
            _successfulTransaction(_call(true)),
            SUCCESS_BLOCK,
            1,
            _rule()
        );
    }

    function testRejectsFreeZeroExcessiveOrMismatchedValueMint() external {
        CallSpec memory call = _call(false);
        call.mintParams.mintPrice = 0;
        bytes memory failed =
            _encodedTransaction(_calldata(call), FAILURE_NONCE, SENDER, false, SEADROP, 0, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidMintPrice.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        call = _call(false);
        call.quantity = 0;
        failed = _encodedTransaction(_calldata(call), FAILURE_NONCE, SENDER, false, SEADROP, 0, 0, _noLogs(), 2, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidQuantity.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        call = _call(false);
        call.quantity = 3;
        failed = _encodedTransaction(
            _calldata(call), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE * 3, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidQuantity.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());

        call = _call(false);
        failed = _encodedTransaction(
            _calldata(call), FAILURE_NONCE, SENDER, false, SEADROP, MINT_PRICE - 1, 0, _noLogs(), 2, 1
        );
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidTransactionValue.selector);
        predicate.validate(failed, FAILURE_BLOCK, _successfulTransaction(_call(true)), SUCCESS_BLOCK, 1, _rule());
    }

    function testBindsCollectionAndQuantityAcrossRetry() external {
        CallSpec memory changed = _call(true);
        changed.nftContract = OTHER_NFT;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.RetrySemanticsMismatch.selector);
        predicate.validate(
            _failedTransaction(_call(false)), FAILURE_BLOCK, _successfulTransaction(changed), SUCCESS_BLOCK, 1, _rule()
        );

        changed = _call(true);
        changed.quantity = 2;
        vm.expectRevert(SeaDropPaidRetryPredicateV1.RetrySemanticsMismatch.selector);
        predicate.validate(
            _failedTransaction(_call(false)), FAILURE_BLOCK, _successfulTransaction(changed), SUCCESS_BLOCK, 1, _rule()
        );
    }

    function testBindsEveryMintParamsFieldAcrossRetry() external {
        for (uint256 field; field < 8; ++field) {
            CallSpec memory changed = _call(true);
            if (field == 0) changed.mintParams.mintPrice += 1;
            if (field == 1) changed.mintParams.maxTotalMintableByWallet += 1;
            if (field == 2) changed.mintParams.startTime += 1;
            if (field == 3) changed.mintParams.endTime += 1;
            if (field == 4) changed.mintParams.dropStageIndex += 1;
            if (field == 5) changed.mintParams.maxTokenSupplyForStage += 1;
            if (field == 6) changed.mintParams.feeBps += 1;
            if (field == 7) changed.mintParams.restrictFeeRecipients = !changed.mintParams.restrictFeeRecipients;

            vm.expectRevert(SeaDropPaidRetryPredicateV1.RetrySemanticsMismatch.selector);
            predicate.validate(
                _failedTransaction(_call(false)),
                FAILURE_BLOCK,
                _successfulTransaction(changed),
                SUCCESS_BLOCK,
                1,
                _rule()
            );
        }
    }

    function testRequiresExactlyOneCorrectSeaDropMint() external {
        CallSpec memory successfulCall = _call(true);
        EvmV1Decoder.LogEntryTuple[] memory logs = _successLogs(successfulCall, SENDER);
        EvmV1Decoder.LogEntryTuple[] memory missing = _removeLog(logs, 0);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.RequiredSeaDropMintMissing.selector);
        _validateWithSuccessLogs(successfulCall, missing);

        EvmV1Decoder.LogEntryTuple[] memory duplicate = _appendLog(logs, logs[0]);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.DuplicateSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, duplicate);

        logs = _successLogs(successfulCall, SENDER);
        logs[0].data = abi.encode(address(0xBAD), uint256(1), MINT_PRICE, uint256(1_000), uint256(2));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        logs = _successLogs(successfulCall, SENDER);
        logs[0].topics[2] = bytes32(uint256(uint160(OTHER_SENDER)));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        logs = _successLogs(successfulCall, SENDER);
        logs[0].data = bytes.concat(logs[0].data, bytes32(0));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, logs);
    }

    function testSeaDropMintBindsEveryOutcomeField() external {
        CallSpec memory successfulCall = _call(true);
        for (uint256 field; field < 4; ++field) {
            EvmV1Decoder.LogEntryTuple[] memory mutatedLogs = _successLogs(successfulCall, SENDER);
            uint256 quantity = successfulCall.quantity;
            uint256 price = successfulCall.mintParams.mintPrice;
            uint256 feeBps = successfulCall.mintParams.feeBps;
            uint256 stage = successfulCall.mintParams.dropStageIndex;
            if (field == 0) quantity += 1;
            if (field == 1) price += 1;
            if (field == 2) feeBps += 1;
            if (field == 3) stage += 1;
            mutatedLogs[0].data = abi.encode(SENDER, quantity, price, feeBps, stage);
            vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
            _validateWithSuccessLogs(successfulCall, mutatedLogs);
        }

        EvmV1Decoder.LogEntryTuple[] memory logs = _successLogs(successfulCall, SENDER);
        logs[0].topics[1] = bytes32(uint256(uint160(OTHER_NFT)));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        logs = _successLogs(successfulCall, SENDER);
        logs[0].topics[3] = bytes32(uint256(uint160(address(0xFEE))));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidSeaDropMint.selector);
        _validateWithSuccessLogs(successfulCall, logs);
    }

    function testRequiresExactDistinctErc721MintsToSender() external {
        CallSpec memory successfulCall = _call(true);
        EvmV1Decoder.LogEntryTuple[] memory logs = _successLogs(successfulCall, SENDER);
        EvmV1Decoder.LogEntryTuple[] memory missing = _removeLog(logs, 1);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.RequiredMintTransferMissing.selector);
        _validateWithSuccessLogs(successfulCall, missing);

        logs = _successLogs(successfulCall, SENDER);
        logs[1].topics[2] = bytes32(uint256(uint160(OTHER_SENDER)));
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidMintTransfer.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        logs = _successLogs(successfulCall, SENDER);
        logs[1].data = hex"00";
        vm.expectRevert(SeaDropPaidRetryPredicateV1.InvalidMintTransfer.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        EvmV1Decoder.LogEntryTuple memory extra = _erc721MintLog(NFT, SENDER, 999);
        logs = _appendLog(_successLogs(successfulCall, SENDER), extra);
        vm.expectRevert(SeaDropPaidRetryPredicateV1.DuplicateMintTransfer.selector);
        _validateWithSuccessLogs(successfulCall, logs);

        successfulCall.quantity = 2;
        logs = _successLogs(successfulCall, SENDER);
        logs[2].topics[3] = logs[1].topics[3];
        vm.expectRevert(SeaDropPaidRetryPredicateV1.DuplicateMintTransfer.selector);
        _validateWithSuccessLogs(successfulCall, logs);
    }

    function testIgnoresUnrelatedLogsButNotMalformedMatchingOutcomes() external view {
        CallSpec memory successfulCall = _call(true);
        EvmV1Decoder.LogEntryTuple[] memory logs = _successLogs(successfulCall, SENDER);
        bytes32[] memory unrelatedTopics = new bytes32[](1);
        unrelatedTopics[0] = keccak256("Unrelated(uint256)");
        EvmV1Decoder.LogEntryTuple memory unrelated = EvmV1Decoder.LogEntryTuple({
            address_: address(0xCAFE), topics: unrelatedTopics, data: abi.encode(uint256(42))
        });
        logs = _appendLog(logs, unrelated);
        predicate.validate(
            _failedTransaction(_call(false)),
            FAILURE_BLOCK,
            _encodedTransaction(
                _calldata(successfulCall), FAILURE_NONCE + 1, SENDER, false, SEADROP, MINT_PRICE, 1, logs, 2, 1
            ),
            SUCCESS_BLOCK,
            1,
            _rule()
        );
    }

    function _validateWithSuccessLogs(CallSpec memory successfulCall, EvmV1Decoder.LogEntryTuple[] memory successLogs)
        private
    {
        bytes memory successful = _encodedTransaction(
            _calldata(successfulCall),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            successfulCall.mintParams.mintPrice * successfulCall.quantity,
            1,
            successLogs,
            2,
            1
        );
        predicate.validate(_failedTransaction(_call(false)), FAILURE_BLOCK, successful, SUCCESS_BLOCK, 1, _rule());
    }

    function _rule() private pure returns (SeaDropPaidRetryPredicateV1.Rule memory rule) {
        rule = SeaDropPaidRetryPredicateV1.Rule({
            feeRecipient: FEE_RECIPIENT, startBlock: START_BLOCK, endBlock: END_BLOCK, maxBlockGap: 5, maxQuantity: 2
        });
    }

    function _call(bool refreshed) private pure returns (CallSpec memory spec) {
        spec.nftContract = NFT;
        spec.feeRecipient = FEE_RECIPIENT;
        spec.quantity = 1;
        spec.mintParams = SeaDropPaidRetryPredicateV1.MintParams({
            mintPrice: MINT_PRICE,
            maxTotalMintableByWallet: 1,
            startTime: 1_776_265_200,
            endTime: 1_776_268_800,
            dropStageIndex: 2,
            maxTokenSupplyForStage: 3_000,
            feeBps: 1_000,
            restrictFeeRecipients: true
        });
        spec.salt = refreshed ? 22 : 11;
        spec.signature = new bytes(65);
        spec.signature[64] = refreshed ? bytes1(0x1c) : bytes1(0x1b);
    }

    function _failedTransaction(CallSpec memory spec) private pure returns (bytes memory) {
        return _encodedTransaction(
            _calldata(spec),
            FAILURE_NONCE,
            SENDER,
            false,
            SEADROP,
            spec.mintParams.mintPrice * spec.quantity,
            0,
            _noLogs(),
            2,
            1
        );
    }

    function _successfulTransaction(CallSpec memory spec) private pure returns (bytes memory) {
        return _encodedTransaction(
            _calldata(spec),
            FAILURE_NONCE + 1,
            SENDER,
            false,
            SEADROP,
            spec.mintParams.mintPrice * spec.quantity,
            1,
            _successLogs(spec, SENDER),
            2,
            1
        );
    }

    function _calldata(CallSpec memory spec) private pure returns (bytes memory) {
        return abi.encodeWithSelector(
            MINT_SIGNED_SELECTOR,
            spec.nftContract,
            spec.feeRecipient,
            spec.minterIfNotPayer,
            spec.quantity,
            spec.mintParams,
            spec.salt,
            spec.signature
        );
    }

    function _attributedCalldata(CallSpec memory spec) private pure returns (bytes memory) {
        return bytes.concat(_calldata(spec), abi.encodePacked(OPENSEA_ATTRIBUTION_SUFFIX));
    }

    function _successLogs(CallSpec memory spec, address sender)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory logs)
    {
        logs = new EvmV1Decoder.LogEntryTuple[](1 + spec.quantity);
        logs[0] = _seaDropMintLog(spec, sender);
        for (uint256 i; i < spec.quantity; ++i) {
            logs[i + 1] = _erc721MintLog(spec.nftContract, sender, 516 + i);
        }
    }

    function _seaDropMintLog(CallSpec memory spec, address sender)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)");
        topics[1] = bytes32(uint256(uint160(spec.nftContract)));
        topics[2] = bytes32(uint256(uint160(sender)));
        topics[3] = bytes32(uint256(uint160(spec.feeRecipient)));
        log = EvmV1Decoder.LogEntryTuple({
            address_: 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5,
            topics: topics,
            data: abi.encode(
                sender, spec.quantity, spec.mintParams.mintPrice, spec.mintParams.feeBps, spec.mintParams.dropStageIndex
            )
        });
    }

    function _erc721MintLog(address nft, address recipient, uint256 tokenId)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory log)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(0);
        topics[2] = bytes32(uint256(uint160(recipient)));
        topics[3] = bytes32(tokenId);
        log = EvmV1Decoder.LogEntryTuple({address_: nft, topics: topics, data: bytes("")});
    }

    function _encodedTransaction(
        bytes memory transactionData,
        uint64 nonce,
        address sender,
        bool toIsNull,
        address target,
        uint256 value,
        uint8 receiptStatus,
        EvmV1Decoder.LogEntryTuple[] memory logs,
        uint8 transactionType,
        uint64 encodedChainId
    ) private pure returns (bytes memory) {
        bytes memory common = _commonFields(transactionData, nonce, sender, toIsNull, target, value);
        bytes memory typeSpecific = _typeSpecificFields(encodedChainId);
        bytes memory receipt = abi.encode(receiptStatus, uint64(150_000), logs, new bytes(256));
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = common;
        chunks[1] = typeSpecific;
        chunks[2] = receipt;
        return abi.encode(transactionType, chunks);
    }

    function _commonFields(
        bytes memory transactionData,
        uint64 nonce,
        address sender,
        bool toIsNull,
        address target,
        uint256 value
    ) private pure returns (bytes memory) {
        return abi.encode(nonce, uint64(300_000), sender, toIsNull, target, value, transactionData);
    }

    function _typeSpecificFields(uint64 encodedChainId) private pure returns (bytes memory) {
        EvmV1Decoder.AccessListEntry[] memory accessList = new EvmV1Decoder.AccessListEntry[](0);
        return abi.encode(
            encodedChainId,
            uint128(1_000_000_000),
            uint128(2_000_000_000),
            accessList,
            uint8(0),
            bytes32(uint256(1)),
            bytes32(uint256(2))
        );
    }

    function _noLogs() private pure returns (EvmV1Decoder.LogEntryTuple[] memory) {
        return new EvmV1Decoder.LogEntryTuple[](0);
    }

    function _removeLog(EvmV1Decoder.LogEntryTuple[] memory logs, uint256 removed)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory result)
    {
        result = new EvmV1Decoder.LogEntryTuple[](logs.length - 1);
        uint256 cursor;
        for (uint256 i; i < logs.length; ++i) {
            if (i != removed) result[cursor++] = logs[i];
        }
    }

    function _appendLog(EvmV1Decoder.LogEntryTuple[] memory logs, EvmV1Decoder.LogEntryTuple memory extra)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory result)
    {
        result = new EvmV1Decoder.LogEntryTuple[](logs.length + 1);
        for (uint256 i; i < logs.length; ++i) {
            result[i] = logs[i];
        }
        result[logs.length] = extra;
    }
}
