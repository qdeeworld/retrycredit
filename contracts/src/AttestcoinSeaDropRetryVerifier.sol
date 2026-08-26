// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {SeaDropPaidRetryPredicateV1} from "./SeaDropPaidRetryPredicateV1.sol";
import {INativeQueryVerifier} from "./interfaces/INativeQueryVerifier.sol";

/// @notice Proves one failed then successful Ethereum SeaDrop mint in a single Attestcoin batch.
/// @dev The source identity is deliberately fixed to Creditcoin chain key 3 (Ethereum mainnet).
contract AttestcoinSeaDropRetryVerifier {
    address public constant NATIVE_VERIFIER = 0x0000000000000000000000000000000000000FD2;
    uint64 public constant SOURCE_CHAIN_KEY = 3;
    uint64 public constant SOURCE_CHAIN_ID = 1;
    bytes32 public constant PAIR_DOMAIN = keccak256("RETRYCREDIT_SEADROP_RETRY_PAIR_V1");

    struct BatchProof {
        uint64[] sourceBlocks;
        bytes[] encodedTransactions;
        INativeQueryVerifier.MerkleProof[] merkleProofs;
        bytes32 lowerEndpointDigest;
        bytes32[] continuityRoots;
    }

    INativeQueryVerifier public immutable verifier;
    SeaDropPaidRetryPredicateV1 public immutable predicate;

    error InvalidBatch();
    error InvalidConfiguration();
    error InvalidProofOrder();
    error ProofVerificationFailed();

    /// @param verifierOverride Test-only/local override. Passing zero selects Attestcoin's native verifier.
    constructor(SeaDropPaidRetryPredicateV1 predicate_, address verifierOverride) {
        if (address(predicate_) == address(0) || address(predicate_).code.length == 0) revert InvalidConfiguration();
        address verifierAddress = verifierOverride == address(0) ? NATIVE_VERIFIER : verifierOverride;
        if (verifierAddress == address(0)) revert InvalidConfiguration();
        predicate = predicate_;
        verifier = INativeQueryVerifier(verifierAddress);
    }

    function verifyRelease(BatchProof calldata proof, SeaDropPaidRetryPredicateV1.Rule calldata rule)
        external
        returns (address beneficiary, bytes32 actionId, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId)
    {
        _verifyBatch(proof);
        return _validateAndIdentify(proof, rule);
    }

    function _verifyBatch(BatchProof calldata proof) private {
        if (proof.sourceBlocks.length != 2 || proof.encodedTransactions.length != 2 || proof.merkleProofs.length != 2) {
            revert InvalidBatch();
        }
        if (proof.sourceBlocks[1] <= proof.sourceBlocks[0]) revert InvalidProofOrder();

        INativeQueryVerifier.ContinuityProof memory continuityProof = INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: proof.lowerEndpointDigest, roots: proof.continuityRoots
        });
        bool verified = verifier.verifyAndEmit(
            SOURCE_CHAIN_KEY, proof.sourceBlocks, proof.encodedTransactions, proof.merkleProofs, continuityProof
        );
        if (!verified) revert ProofVerificationFailed();
    }

    function _validateAndIdentify(BatchProof calldata proof, SeaDropPaidRetryPredicateV1.Rule calldata rule)
        private
        view
        returns (address beneficiary, bytes32 actionId, bytes32 failureQueryId, bytes32 successQueryId, bytes32 pairId)
    {
        (beneficiary, actionId) = predicate.validate(
            proof.encodedTransactions[0],
            proof.sourceBlocks[0],
            proof.encodedTransactions[1],
            proof.sourceBlocks[1],
            SOURCE_CHAIN_ID,
            rule
        );

        failureQueryId = _queryId(proof.sourceBlocks[0], verifier.calculateTxIndex(proof.merkleProofs[0]));
        successQueryId = _queryId(proof.sourceBlocks[1], verifier.calculateTxIndex(proof.merkleProofs[1]));
        pairId = keccak256(
            abi.encode(PAIR_DOMAIN, SOURCE_CHAIN_KEY, SOURCE_CHAIN_ID, actionId, failureQueryId, successQueryId)
        );
    }

    function _queryId(uint64 sourceBlock, uint64 transactionIndex) private pure returns (bytes32) {
        return keccak256(abi.encode(SOURCE_CHAIN_KEY, sourceBlock, transactionIndex));
    }
}
