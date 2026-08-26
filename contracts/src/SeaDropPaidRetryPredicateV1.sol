// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @notice Validates one organic paid SeaDrop mint failure followed by its successful retry on Ethereum mainnet.
/// @dev Inclusion and shared batch continuity are verified separately by the Attestcoin batch verifier.
contract SeaDropPaidRetryPredicateV1 {
    uint64 public constant ETHEREUM_CHAIN_ID = 1;
    uint32 public constant MAX_ATTESTCOIN_BATCH_BLOCK_GAP = 1_000;

    address public constant SEADROP = 0x00005EA00Ac477B1030CE78506496e8C2dE24bf5;
    bytes4 public constant MINT_SIGNED_SELECTOR = 0x4b61cd6f;
    bytes4 public constant OPENSEA_ATTRIBUTION_SUFFIX = 0x3d958fe2;
    bytes32 public constant SEADROP_MINT_EVENT =
        keccak256("SeaDropMint(address,address,address,address,uint256,uint256,uint256,uint256)");
    bytes32 public constant ERC721_TRANSFER_EVENT = keccak256("Transfer(address,address,uint256)");

    struct Rule {
        address feeRecipient;
        uint64 startBlock;
        uint64 endBlock;
        uint32 maxBlockGap;
        uint8 maxQuantity;
    }

    struct MintParams {
        uint256 mintPrice;
        uint256 maxTotalMintableByWallet;
        uint256 startTime;
        uint256 endTime;
        uint256 dropStageIndex;
        uint256 maxTokenSupplyForStage;
        uint256 feeBps;
        bool restrictFeeRecipients;
    }

    struct MintCall {
        address nftContract;
        address feeRecipient;
        address minterIfNotPayer;
        uint256 quantity;
        MintParams mintParams;
        uint256 salt;
        bytes signature;
    }

    struct Attempt {
        address sender;
        uint64 nonce;
        MintCall mint;
    }

    error DuplicateMintTransfer();
    error DuplicateSeaDropMint();
    error InvalidBlockGap();
    error InvalidCalldata();
    error InvalidFeeRecipient();
    error InvalidMintPrice();
    error InvalidMintTransfer();
    error InvalidMinter();
    error InvalidNonceSequence();
    error InvalidParticipant();
    error InvalidQuantity();
    error InvalidReceiptSequence();
    error InvalidRule();
    error InvalidSeaDropMint();
    error InvalidSourceBlock();
    error InvalidSourceChain();
    error InvalidSourceTransaction();
    error InvalidTarget();
    error InvalidTransactionValue();
    error RequiredMintTransferMissing();
    error RequiredSeaDropMintMissing();
    error RetrySemanticsMismatch();

    function validateTerms(Rule calldata rule) external pure {
        _validateRule(rule);
    }

    function validate(
        bytes calldata failedEncodedTransaction,
        uint64 failureBlock,
        bytes calldata successfulEncodedTransaction,
        uint64 successBlock,
        uint64 sourceChainId,
        Rule calldata rule
    ) external pure returns (address beneficiary, bytes32 actionId) {
        _validateRule(rule);
        if (sourceChainId != ETHEREUM_CHAIN_ID) revert InvalidSourceChain();
        if (failureBlock < rule.startBlock || successBlock > rule.endBlock || successBlock <= failureBlock) {
            revert InvalidSourceBlock();
        }
        if (uint256(successBlock) - uint256(failureBlock) > rule.maxBlockGap) revert InvalidBlockGap();

        Attempt memory failed = _validateAttempt(failedEncodedTransaction, rule, false);
        Attempt memory succeeded = _validateAttempt(successfulEncodedTransaction, rule, true);

        if (failed.sender == address(0) || succeeded.sender != failed.sender) revert InvalidParticipant();
        if (failed.nonce == type(uint64).max || succeeded.nonce != failed.nonce + 1) revert InvalidNonceSequence();
        if (!_sameSemantics(failed.mint, succeeded.mint)) revert RetrySemanticsMismatch();

        beneficiary = failed.sender;
        actionId = keccak256(
            abi.encode(
                "RETRYCREDIT_SEADROP_PAID_RETRY_V1",
                sourceChainId,
                SEADROP,
                beneficiary,
                failureBlock,
                successBlock,
                failed.nonce,
                succeeded.nonce,
                _semanticHash(failed.mint)
            )
        );
    }

    function _validateRule(Rule calldata rule) private pure {
        if (
            rule.feeRecipient == address(0) || rule.startBlock >= rule.endBlock || rule.maxBlockGap == 0
                || rule.maxBlockGap > MAX_ATTESTCOIN_BATCH_BLOCK_GAP || rule.maxQuantity == 0
        ) revert InvalidRule();
    }

    function _validateAttempt(bytes calldata encodedTransaction, Rule calldata rule, bool successful)
        private
        pure
        returns (Attempt memory attempt)
    {
        if (encodedTransaction.length == 0 || EvmV1Decoder.getTransactionType(encodedTransaction) != 2) {
            revert InvalidSourceTransaction();
        }

        EvmV1Decoder.Type2Fields memory type2 = EvmV1Decoder.decodeTypeSpecificFieldsType2(encodedTransaction);
        if (type2.chainId != ETHEREUM_CHAIN_ID) revert InvalidSourceChain();

        EvmV1Decoder.CommonTxFields memory transaction = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
        if (transaction.from == address(0)) revert InvalidParticipant();
        if (transaction.toIsNull || transaction.to != SEADROP) revert InvalidTarget();

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != (successful ? 1 : 0)) revert InvalidReceiptSequence();
        if (!successful && receipt.receiptLogs.length != 0) revert InvalidReceiptSequence();

        MintCall memory mint = _decodeMintSigned(transaction.data);
        _validateMintCall(mint, transaction.value, rule);
        if (successful) _validateSuccessfulReceipt(receipt, mint, transaction.from);

        attempt = Attempt({sender: transaction.from, nonce: transaction.nonce, mint: mint});
    }

    function _validateMintCall(MintCall memory mint, uint256 transactionValue, Rule calldata rule) private pure {
        if (mint.nftContract == address(0)) revert InvalidTarget();
        if (mint.feeRecipient != rule.feeRecipient) revert InvalidFeeRecipient();
        if (mint.minterIfNotPayer != address(0)) revert InvalidMinter();
        if (mint.quantity == 0 || mint.quantity > rule.maxQuantity) revert InvalidQuantity();
        if (mint.mintParams.mintPrice == 0) revert InvalidMintPrice();
        if (mint.mintParams.mintPrice > type(uint256).max / mint.quantity) revert InvalidTransactionValue();
        if (transactionValue != mint.mintParams.mintPrice * mint.quantity) revert InvalidTransactionValue();
    }

    function _decodeMintSigned(bytes memory data) private pure returns (MintCall memory mint) {
        if (data.length < 4) revert InvalidCalldata();
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
        if (selector != MINT_SIGNED_SELECTOR) revert InvalidCalldata();

        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i; i < arguments.length; ++i) {
            arguments[i] = data[i + 4];
        }
        (
            mint.nftContract,
            mint.feeRecipient,
            mint.minterIfNotPayer,
            mint.quantity,
            mint.mintParams,
            mint.salt,
            mint.signature
        ) = abi.decode(arguments, (address, address, address, uint256, MintParams, uint256, bytes));

        bytes memory canonical = abi.encodeWithSelector(
            MINT_SIGNED_SELECTOR,
            mint.nftContract,
            mint.feeRecipient,
            mint.minterIfNotPayer,
            mint.quantity,
            mint.mintParams,
            mint.salt,
            mint.signature
        );
        if (!_isCanonicalOrOpenSeaAttributed(data, canonical)) revert InvalidCalldata();
    }

    function _isCanonicalOrOpenSeaAttributed(bytes memory data, bytes memory canonical) private pure returns (bool) {
        if (data.length == canonical.length) return keccak256(data) == keccak256(canonical);
        if (data.length != canonical.length + 4) return false;

        for (uint256 i; i < canonical.length; ++i) {
            if (data[i] != canonical[i]) return false;
        }

        bytes4 suffix;
        uint256 suffixOffset = canonical.length;
        assembly ("memory-safe") {
            suffix := mload(add(add(data, 0x20), suffixOffset))
        }
        return suffix == OPENSEA_ATTRIBUTION_SUFFIX;
    }

    function _validateSuccessfulReceipt(EvmV1Decoder.ReceiptFields memory receipt, MintCall memory mint, address sender)
        private
        pure
    {
        uint256 seaDropMintCount;
        uint256 mintTransferCount;
        bytes32[] memory mintedTokenIds = new bytes32[](mint.quantity);

        for (uint256 i; i < receipt.receiptLogs.length; ++i) {
            EvmV1Decoder.LogEntry memory log = receipt.receiptLogs[i];
            if (log.topics.length == 0) continue;

            if (log.address_ == SEADROP && log.topics[0] == SEADROP_MINT_EVENT) {
                if (!_isExpectedSeaDropMint(log, mint, sender)) revert InvalidSeaDropMint();
                ++seaDropMintCount;
                if (seaDropMintCount > 1) revert DuplicateSeaDropMint();
                continue;
            }

            if (log.address_ != mint.nftContract || log.topics[0] != ERC721_TRANSFER_EVENT) continue;
            if (log.topics.length != 4 || log.data.length != 0) revert InvalidMintTransfer();
            if (log.topics[1] != bytes32(0)) continue;
            if (log.topics[2] != bytes32(uint256(uint160(sender)))) revert InvalidMintTransfer();

            bytes32 tokenId = log.topics[3];
            for (uint256 j; j < mintTransferCount; ++j) {
                if (mintedTokenIds[j] == tokenId) revert DuplicateMintTransfer();
            }
            if (mintTransferCount >= mint.quantity) revert DuplicateMintTransfer();
            mintedTokenIds[mintTransferCount++] = tokenId;
        }

        if (seaDropMintCount == 0) revert RequiredSeaDropMintMissing();
        if (mintTransferCount != mint.quantity) revert RequiredMintTransferMissing();
    }

    function _isExpectedSeaDropMint(EvmV1Decoder.LogEntry memory log, MintCall memory mint, address sender)
        private
        pure
        returns (bool)
    {
        if (
            log.topics.length != 4 || log.data.length != 160
                || log.topics[1] != bytes32(uint256(uint160(mint.nftContract)))
                || log.topics[2] != bytes32(uint256(uint160(sender)))
                || log.topics[3] != bytes32(uint256(uint160(mint.feeRecipient)))
        ) return false;

        (address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex) =
            abi.decode(log.data, (address, uint256, uint256, uint256, uint256));
        return payer == sender && quantityMinted == mint.quantity && unitMintPrice == mint.mintParams.mintPrice
            && feeBps == mint.mintParams.feeBps && dropStageIndex == mint.mintParams.dropStageIndex;
    }

    function _sameSemantics(MintCall memory a, MintCall memory b) private pure returns (bool) {
        return a.nftContract == b.nftContract && a.feeRecipient == b.feeRecipient
            && a.minterIfNotPayer == b.minterIfNotPayer && a.quantity == b.quantity
            && a.mintParams.mintPrice == b.mintParams.mintPrice
            && a.mintParams.maxTotalMintableByWallet == b.mintParams.maxTotalMintableByWallet
            && a.mintParams.startTime == b.mintParams.startTime && a.mintParams.endTime == b.mintParams.endTime
            && a.mintParams.dropStageIndex == b.mintParams.dropStageIndex
            && a.mintParams.maxTokenSupplyForStage == b.mintParams.maxTokenSupplyForStage
            && a.mintParams.feeBps == b.mintParams.feeBps
            && a.mintParams.restrictFeeRecipients == b.mintParams.restrictFeeRecipients;
    }

    function _semanticHash(MintCall memory mint) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                mint.nftContract,
                mint.feeRecipient,
                mint.minterIfNotPayer,
                mint.quantity,
                mint.mintParams.mintPrice,
                mint.mintParams.maxTotalMintableByWallet,
                mint.mintParams.startTime,
                mint.mintParams.endTime,
                mint.mintParams.dropStageIndex,
                mint.mintParams.maxTokenSupplyForStage,
                mint.mintParams.feeBps,
                mint.mintParams.restrictFeeRecipients
            )
        );
    }
}
