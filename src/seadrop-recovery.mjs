import { ethers } from "ethers";

export const ETHEREUM_MAINNET_CHAIN_ID = 1;
export const SEA_DROP_MAINNET = ethers.getAddress("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
export const OPEN_SEA_FEE_RECIPIENT = ethers.getAddress(
  "0x0000a26b00c1F0DF003000390027140000fAa719",
);

export const MINT_PARAM_FIELDS = Object.freeze([
  "mintPrice",
  "maxTotalMintableByWallet",
  "startTime",
  "endTime",
  "dropStageIndex",
  "maxTokenSupplyForStage",
  "feeBps",
  "restrictFeeRecipients",
]);

const ZERO_ADDRESS = ethers.ZeroAddress;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const SEA_DROP_ABI = [
  "function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature)",
  "event SeaDropMint(address indexed nftContract,address indexed minter,address indexed feeRecipient,address payer,uint256 quantity,uint256 mintPrice,uint256 feeBps,uint256 dropStageIndex)",
];

const ERC721_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
];

export const SEA_DROP_INTERFACE = new ethers.Interface(SEA_DROP_ABI);
const ERC721_INTERFACE = new ethers.Interface(ERC721_ABI);
export const MINT_SIGNED_SELECTOR = SEA_DROP_INTERFACE.getFunction("mintSigned").selector;
export const SEA_DROP_MINT_TOPIC = SEA_DROP_INTERFACE.getEvent("SeaDropMint").topicHash;
export const OPEN_SEA_CALLDATA_SUFFIX = "0x3d958fe2";

export class SeaDropRecoveryError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "SeaDropRecoveryError";
    this.code = code;
  }
}

export function decodeCanonicalSeaDropMintSigned(data) {
  try {
    if (typeof data !== "string" || !ethers.isHexString(data)) {
      fail("INVALID_CALLDATA", "SeaDrop calldata must be a hex string");
    }
    if (data.slice(0, 10).toLowerCase() !== MINT_SIGNED_SELECTOR.toLowerCase()) {
      fail("INVALID_SELECTOR", `SeaDrop calldata must use ${MINT_SIGNED_SELECTOR}`);
    }

    const decoded = SEA_DROP_INTERFACE.decodeFunctionData("mintSigned", data);
    const signature = ethers.hexlify(decoded.signature).toLowerCase();
    const signatureLength = ethers.dataLength(signature);
    if (signatureLength !== 64 && signatureLength !== 65) {
      fail("INVALID_SIGNATURE", "mintSigned authorization must be a 64- or 65-byte signature");
    }

    const result = {
      nftContract: normalizeAddress(decoded.nftContract, "nftContract"),
      feeRecipient: normalizeAddress(decoded.feeRecipient, "feeRecipient"),
      minterIfNotPayer: normalizeAddress(decoded.minterIfNotPayer, "minterIfNotPayer"),
      quantity: requirePositiveUint(decoded.quantity, "quantity"),
      mintParams: normalizeMintParams(decoded.mintParams),
      salt: requireUint(decoded.salt, "salt"),
      signature,
    };

    const canonical = SEA_DROP_INTERFACE.encodeFunctionData("mintSigned", [
      result.nftContract,
      result.feeRecipient,
      result.minterIfNotPayer,
      result.quantity,
      mintParamsAsTuple(result.mintParams),
      result.salt,
      result.signature,
    ]);
    const calldataSuffix = parseCalldataSuffix(data, canonical, signatureLength);

    return freezeDeep({ ...result, calldataSuffix });
  } catch (error) {
    if (error instanceof SeaDropRecoveryError) throw error;
    throw new SeaDropRecoveryError(
      "INVALID_CALLDATA",
      "SeaDrop calldata is not a canonical mintSigned invocation",
      error,
    );
  }
}

export function normalizeSeaDropRecoveryProfile(profile) {
  try {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      fail("INVALID_PROFILE", "a complete SeaDrop recovery profile is required");
    }
    if (typeof profile.requirePaid !== "boolean") {
      fail("INVALID_PROFILE", "profile.requirePaid must be explicit");
    }

    const normalized = {
      sourceChainId: requireSafeUint(
        profile.sourceChainId ?? ETHEREUM_MAINNET_CHAIN_ID,
        "profile.sourceChainId",
      ),
      seaDrop: normalizeAddress(profile.seaDrop ?? SEA_DROP_MAINNET, "profile.seaDrop"),
      nftContract: normalizeAddress(profile.nftContract, "profile.nftContract"),
      feeRecipient: normalizeAddress(profile.feeRecipient, "profile.feeRecipient"),
      minterIfNotPayer: normalizeAddress(
        profile.minterIfNotPayer ?? ZERO_ADDRESS,
        "profile.minterIfNotPayer",
      ),
      quantity: requirePositiveUint(profile.quantity, "profile.quantity"),
      valueWei: requireUint(profile.valueWei, "profile.valueWei"),
      mintParams: normalizeMintParams(profile.mintParams, "profile.mintParams"),
      maxBlockGap: requireSafePositiveUint(profile.maxBlockGap, "profile.maxBlockGap"),
      requirePaid: profile.requirePaid,
      calldataSuffix: normalizeCalldataSuffix(profile.calldataSuffix ?? "0x"),
    };

    if (normalized.sourceChainId !== ETHEREUM_MAINNET_CHAIN_ID) {
      fail("INVALID_PROFILE", "SeaDrop recovery is bound to Ethereum mainnet");
    }
    if (normalized.seaDrop !== SEA_DROP_MAINNET) {
      fail("INVALID_PROFILE", "profile must use the canonical Ethereum-mainnet SeaDrop contract");
    }
    if (normalized.nftContract === ZERO_ADDRESS) {
      fail("INVALID_PROFILE", "profile.nftContract must be nonzero");
    }
    if (normalized.feeRecipient === ZERO_ADDRESS) {
      fail("INVALID_PROFILE", "profile.feeRecipient must be nonzero");
    }
    if (normalized.minterIfNotPayer !== ZERO_ADDRESS) {
      fail("INVALID_PROFILE", "recovery profiles must mint to the source payer");
    }
    if (!normalized.mintParams.restrictFeeRecipients) {
      fail("INVALID_PROFILE", "signed-mint recovery profiles must restrict fee recipients");
    }

    const exactPayment = normalized.quantity * normalized.mintParams.mintPrice;
    if (normalized.valueWei !== exactPayment) {
      fail("INVALID_PROFILE", "profile value must equal quantity multiplied by mint price");
    }
    if (normalized.requirePaid && exactPayment === 0n) {
      fail("INVALID_PROFILE", "paid recovery profiles must have a nonzero mint payment");
    }

    return freezeDeep(normalized);
  } catch (error) {
    if (error instanceof SeaDropRecoveryError) throw error;
    throw new SeaDropRecoveryError("INVALID_PROFILE", "SeaDrop recovery profile is invalid", error);
  }
}

export function validateSeaDropRecoveryPair({
  failedTransaction,
  failedReceipt,
  successfulTransaction,
  successfulReceipt,
  profile,
}) {
  try {
    const expected = normalizeSeaDropRecoveryProfile(profile);
    const failedTx = normalizeTransaction(failedTransaction, "failed transaction");
    const successfulTx = normalizeTransaction(successfulTransaction, "successful transaction");
    const failedRc = normalizeReceipt(failedReceipt, "failed receipt");
    const successfulRc = normalizeReceipt(successfulReceipt, "successful receipt");

    validateTransactionReceiptBinding(failedTx, failedRc, "failed");
    validateTransactionReceiptBinding(successfulTx, successfulRc, "successful");

    equal(failedTx.chainId, expected.sourceChainId, "failed transaction source chain");
    equal(successfulTx.chainId, expected.sourceChainId, "successful transaction source chain");
    equal(failedTx.type, 2, "failed transaction envelope type");
    equal(successfulTx.type, 2, "successful transaction envelope type");
    equal(failedTx.to, expected.seaDrop, "failed transaction target");
    equal(successfulTx.to, expected.seaDrop, "successful transaction target");
    equal(successfulTx.from, failedTx.from, "source sender");
    if (failedTx.hash === successfulTx.hash) {
      fail("INVALID_PAIR", "failure and success must be different transactions");
    }
    equal(successfulTx.nonce, failedTx.nonce + 1, "consecutive source nonce");

    const blockGap = successfulTx.blockNumber - failedTx.blockNumber;
    if (blockGap <= 0 || blockGap > expected.maxBlockGap) {
      fail(
        "INVALID_PAIR",
        `successful transaction must follow within ${expected.maxBlockGap} blocks`,
      );
    }
    equal(failedRc.status, 0, "failed receipt status");
    equal(successfulRc.status, 1, "successful receipt status");
    if (failedRc.logs.length !== 0) {
      fail("INVALID_FAILURE", "failed SeaDrop receipt must contain no logs");
    }

    const failedMint = decodeCanonicalSeaDropMintSigned(failedTx.data);
    const successfulMint = decodeCanonicalSeaDropMintSigned(successfulTx.data);
    validateMintAgainstProfile(failedMint, failedTx.value, expected, "failed");
    validateMintAgainstProfile(successfulMint, successfulTx.value, expected, "successful");
    validateStableMintPair(failedMint, successfulMint, failedTx.value, successfulTx.value);

    const minter = failedTx.from;
    const mintedTokenIds = validateSuccessLogs({
      receipt: successfulRc,
      seaDrop: expected.seaDrop,
      nftContract: expected.nftContract,
      minter,
      payer: failedTx.from,
      feeRecipient: expected.feeRecipient,
      quantity: expected.quantity,
      mintParams: expected.mintParams,
    });

    const stableActionDigest = hashStableAction(failedMint, failedTx.value);
    const actionId = hashContractAction({
      sourceChainId: expected.sourceChainId,
      seaDrop: expected.seaDrop,
      beneficiary: failedTx.from,
      failureBlock: failedTx.blockNumber,
      successBlock: successfulTx.blockNumber,
      failureNonce: failedTx.nonce,
      successNonce: successfulTx.nonce,
      mint: failedMint,
    });
    const sourcePairDigest = ethers.keccak256(
      ethers.concat([ethers.getBytes(failedTx.hash), ethers.getBytes(successfulTx.hash)]),
    );

    return freezeDeep({
      kind: "seadrop-mint-signed-recovery",
      sourceChainId: expected.sourceChainId,
      claimant: failedTx.from,
      payer: failedTx.from,
      recipient: minter,
      seaDrop: expected.seaDrop,
      nftContract: expected.nftContract,
      feeRecipient: expected.feeRecipient,
      quantity: expected.quantity.toString(),
      mintPriceWei: expected.mintParams.mintPrice.toString(),
      valueWei: expected.valueWei.toString(),
      paid: expected.valueWei > 0n,
      calldataSuffix: expected.calldataSuffix,
      blockGap,
      nonceGap: 1,
      stableActionDigest,
      actionId,
      sourcePairDigest,
      authorizationRefreshed:
        failedMint.salt !== successfulMint.salt
        || failedMint.signature !== successfulMint.signature,
      failed: {
        transactionHash: failedTx.hash,
        blockNumber: failedTx.blockNumber,
        nonce: failedTx.nonce,
        status: failedRc.status,
        logCount: failedRc.logs.length,
      },
      successful: {
        transactionHash: successfulTx.hash,
        blockNumber: successfulTx.blockNumber,
        nonce: successfulTx.nonce,
        status: successfulRc.status,
        mintedTokenIds,
      },
      mintParams: stringifyMintParams(expected.mintParams),
    });
  } catch (error) {
    if (error instanceof SeaDropRecoveryError) throw error;
    throw new SeaDropRecoveryError(
      "INVALID_PAIR",
      "transactions do not form an exact SeaDrop recovery pair",
      error,
    );
  }
}

// Advisory checks reuse the semantic validator's normalization and helpers.
// This report never participates in eligibility, proof construction, or payout.
// Incomplete or unbound provider facts cannot produce a rejection report.
export function inspectSeaDropRecoveryPair({
  failedTransaction,
  failedReceipt,
  successfulTransaction,
  successfulReceipt,
  pair,
  rule,
}) {
  try {
    const failedTx = normalizeTransaction(failedTransaction, "failed transaction");
    const successfulTx = normalizeTransaction(successfulTransaction, "successful transaction");
    const failedRc = normalizeReceipt(failedReceipt, "failed receipt");
    const successfulRc = normalizeReceipt(successfulReceipt, "successful receipt");
    validateTransactionReceiptBinding(failedTx, failedRc, "failed");
    validateTransactionReceiptBinding(successfulTx, successfulRc, "successful");
    equal(failedTx.hash, normalizeHash(pair.failedTransactionHash, "requested failure"), "requested failure");
    equal(successfulTx.hash, normalizeHash(pair.successfulTransactionHash, "requested success"), "requested success");
    // Missing or malformed RPC bytes are incomplete facts, not evidence that the
    // source called an unsupported action. Explicit empty bytes remain checkable.
    if (!ethers.isHexString(failedTx.data, true) || !ethers.isHexString(successfulTx.data, true)) return null;
    for (const [transaction, receipt] of [[failedTransaction, failedReceipt], [successfulTransaction, successfulReceipt]]) {
      if (transaction.blockHash != null || receipt.blockHash != null) {
        equal(normalizeHash(transaction.blockHash, "transaction block hash"), normalizeHash(receipt.blockHash, "receipt block hash"), "source block hash");
      }
    }
    const checks = [];
    const check = (id, run, enabled = true) => {
      let status = "not-checked";
      if (enabled) {
        try { run(); status = "pass"; } catch { status = "fail"; }
      }
      checks.push({ id, status });
      return status === "pass";
    };
    check("source-network", () => {
      equal(failedTx.chainId, ETHEREUM_MAINNET_CHAIN_ID, "source chain");
      equal(successfulTx.chainId, ETHEREUM_MAINNET_CHAIN_ID, "source chain");
    });
    check("transaction-type", () => {
      equal(failedTx.type, 2, "transaction type");
      equal(successfulTx.type, 2, "transaction type");
    });
    let failedMint, successfulMint;
    const canonicalMint = check("action-family", () => {
      equal(failedTx.to, SEA_DROP_MAINNET, "canonical target");
      equal(successfulTx.to, SEA_DROP_MAINNET, "canonical target");
      failedMint = decodeCanonicalSeaDropMintSigned(failedTx.data);
      successfulMint = decodeCanonicalSeaDropMintSigned(successfulTx.data);
    });
    const sameWallet = check("same-wallet", () => equal(successfulTx.from, failedTx.from, "source wallet"));
    const receiptStatus = check("receipt-status", () => {
      equal(failedRc.status, 0, "failed status");
      equal(successfulRc.status, 1, "successful status");
      equal(failedRc.logs.length, 0, "failed logs");
    });
    check("nonce-order", () => equal(successfulTx.nonce, failedTx.nonce + 1, "consecutive nonce"), sameWallet);
    check("block-gap", () => {
      const gap = successfulTx.blockNumber - failedTx.blockNumber;
      if (gap <= 0 || gap > Number(rule.maxBlockGap)) fail("INVALID_PAIR", "block gap");
    });
    check("campaign-window", () => {
      if ([failedTx, successfulTx].some(transaction => transaction.blockNumber < Number(rule.startBlock)
        || transaction.blockNumber > Number(rule.endBlock))) {
        fail("INVALID_PAIR", "source window");
      }
    });
    let profile;
    const paidMint = check("paid-mint", () => {
      profile = normalizeSeaDropRecoveryProfile({
        sourceChainId: ETHEREUM_MAINNET_CHAIN_ID,
        seaDrop: SEA_DROP_MAINNET,
        nftContract: failedMint.nftContract,
        feeRecipient: failedMint.feeRecipient,
        minterIfNotPayer: failedMint.minterIfNotPayer,
        quantity: failedMint.quantity,
        valueWei: failedTx.value,
        mintParams: failedMint.mintParams,
        maxBlockGap: Number(rule.maxBlockGap),
        requirePaid: true,
        calldataSuffix: failedMint.calldataSuffix,
      });
    }, canonicalMint);
    const mintIdentity = check("mint-identity", () => {
      validateMintAgainstProfile(failedMint, failedTx.value, profile, "failed");
      validateMintAgainstProfile(successfulMint, successfulTx.value, profile, "successful");
      validateStableMintPair(failedMint, successfulMint, failedTx.value, successfulTx.value);
    }, paidMint);
    check("mint-outcome", () => validateSuccessLogs({
      receipt: successfulRc,
      seaDrop: SEA_DROP_MAINNET,
      nftContract: profile.nftContract,
      minter: failedTx.from,
      payer: failedTx.from,
      feeRecipient: profile.feeRecipient,
      quantity: profile.quantity,
      mintParams: profile.mintParams,
    }), mintIdentity && sameWallet && receiptStatus);
    check("campaign-fee-recipient", () => {
      const recipient = normalizeAddress(rule.feeRecipient, "campaign fee recipient");
      equal(failedMint.feeRecipient, recipient, "campaign fee recipient");
      equal(successfulMint.feeRecipient, recipient, "campaign fee recipient");
    }, canonicalMint);
    check("campaign-quantity", () => {
      if (failedMint.quantity > BigInt(rule.maxQuantity) || successfulMint.quantity > BigInt(rule.maxQuantity)) {
        fail("INVALID_PAIR", "campaign quantity");
      }
    }, canonicalMint);
    return freezeDeep({
      checks,
      facts: {
        failed: { blockNumber: failedTx.blockNumber, nonce: failedTx.nonce, status: failedRc.status },
        successful: { blockNumber: successfulTx.blockNumber, nonce: successfulTx.nonce, status: successfulRc.status },
      },
    });
  } catch {
    return null;
  }
}

function validateMintAgainstProfile(mint, value, profile, label) {
  equal(mint.nftContract, profile.nftContract, `${label} nftContract profile`);
  equal(mint.feeRecipient, profile.feeRecipient, `${label} feeRecipient profile`);
  equal(mint.minterIfNotPayer, profile.minterIfNotPayer, `${label} minter profile`);
  equal(mint.quantity, profile.quantity, `${label} quantity profile`);
  equal(value, profile.valueWei, `${label} transaction value profile`);
  equal(mint.calldataSuffix, profile.calldataSuffix, `${label} calldata suffix profile`);
  for (const field of MINT_PARAM_FIELDS) {
    equal(mint.mintParams[field], profile.mintParams[field], `${label} ${field} profile`);
  }
}

function validateStableMintPair(failedMint, successfulMint, failedValue, successfulValue) {
  for (const field of ["nftContract", "feeRecipient", "minterIfNotPayer", "quantity"]) {
    equal(successfulMint[field], failedMint[field], `stable ${field}`);
  }
  equal(successfulMint.calldataSuffix, failedMint.calldataSuffix, "stable calldata suffix");
  for (const field of MINT_PARAM_FIELDS) {
    equal(successfulMint.mintParams[field], failedMint.mintParams[field], `stable ${field}`);
  }
  equal(successfulValue, failedValue, "stable transaction value");
  equal(failedValue, failedMint.quantity * failedMint.mintParams.mintPrice, "failed exact payment");
  equal(
    successfulValue,
    successfulMint.quantity * successfulMint.mintParams.mintPrice,
    "successful exact payment",
  );
}

function validateSuccessLogs({
  receipt,
  seaDrop,
  nftContract,
  minter,
  payer,
  feeRecipient,
  quantity,
  mintParams,
}) {
  const seaDropEvents = [];
  const transfers = [];

  receipt.logs.forEach((log, receiptIndex) => {
    if (log.address === seaDrop && lower(log.topics[0]) === lower(SEA_DROP_MINT_TOPIC)) {
      seaDropEvents.push({ log, receiptIndex });
    }
    if (log.address === nftContract && lower(log.topics[0]) === lower(TRANSFER_TOPIC)) {
      transfers.push({ log, receiptIndex });
    }
  });

  if (seaDropEvents.length !== 1) {
    fail("INVALID_SUCCESS", "successful receipt must contain exactly one SeaDropMint event");
  }
  if (transfers.length !== Number(quantity)) {
    fail("INVALID_SUCCESS", "successful receipt must mint exactly the requested ERC-721 quantity");
  }

  if (
    seaDropEvents[0].log.topics.length !== 4
    || ethers.dataLength(seaDropEvents[0].log.data) !== 32 * 5
  ) {
    fail("INVALID_SUCCESS", "SeaDropMint must have its exact indexed and data field shape");
  }
  const seaDropEvent = parseLog(SEA_DROP_INTERFACE, seaDropEvents[0].log, "SeaDropMint");
  outcomeEqual(
    normalizeAddress(seaDropEvent.args.nftContract, "event nftContract"),
    nftContract,
    "SeaDropMint nft",
  );
  outcomeEqual(
    normalizeAddress(seaDropEvent.args.minter, "event minter"),
    minter,
    "SeaDropMint minter",
  );
  outcomeEqual(
    normalizeAddress(seaDropEvent.args.feeRecipient, "event feeRecipient"),
    feeRecipient,
    "SeaDropMint fee recipient",
  );
  outcomeEqual(
    normalizeAddress(seaDropEvent.args.payer, "event payer"),
    payer,
    "SeaDropMint payer",
  );
  outcomeEqual(
    requireUint(seaDropEvent.args.quantity, "event quantity"),
    quantity,
    "SeaDropMint quantity",
  );
  outcomeEqual(
    requireUint(seaDropEvent.args.mintPrice, "event mintPrice"),
    mintParams.mintPrice,
    "SeaDropMint price",
  );
  outcomeEqual(
    requireUint(seaDropEvent.args.feeBps, "event feeBps"),
    mintParams.feeBps,
    "SeaDropMint feeBps",
  );
  outcomeEqual(
    requireUint(seaDropEvent.args.dropStageIndex, "event dropStageIndex"),
    mintParams.dropStageIndex,
    "SeaDropMint stage",
  );

  const tokenIds = [];
  const seen = new Set();
  for (const transfer of transfers) {
    if (transfer.receiptIndex >= seaDropEvents[0].receiptIndex) {
      fail("INVALID_SUCCESS", "ERC-721 mint transfers must precede SeaDropMint");
    }
    if (transfer.log.topics.length !== 4 || transfer.log.data !== "0x") {
      fail("INVALID_SUCCESS", "ERC-721 mint Transfer must have its exact indexed field shape");
    }
    const event = parseLog(ERC721_INTERFACE, transfer.log, "Transfer");
    outcomeEqual(
      normalizeAddress(event.args.from, "transfer from"),
      ZERO_ADDRESS,
      "ERC-721 mint source",
    );
    outcomeEqual(
      normalizeAddress(event.args.to, "transfer to"),
      minter,
      "ERC-721 mint recipient",
    );
    const tokenId = requireUint(event.args.tokenId, "transfer tokenId").toString();
    if (seen.has(tokenId)) fail("INVALID_SUCCESS", "minted ERC-721 token IDs must be unique");
    seen.add(tokenId);
    tokenIds.push(tokenId);
  }
  return tokenIds;
}

function normalizeTransaction(transaction, label) {
  if (!transaction || typeof transaction !== "object") {
    fail("INVALID_TRANSACTION", `${label} is required`);
  }
  const chainId = requireSafeUint(transaction.chainId, `${label}.chainId`);
  const type = requireSafeUint(transaction.type, `${label}.type`);
  const blockNumber = requireSafePositiveUint(transaction.blockNumber, `${label}.blockNumber`);
  const nonce = requireSafeUint(transaction.nonce, `${label}.nonce`);
  return {
    hash: normalizeHash(transaction.hash, `${label}.hash`),
    chainId,
    type,
    from: normalizeAddress(transaction.from, `${label}.from`),
    to: normalizeAddress(transaction.to, `${label}.to`),
    nonce,
    blockNumber,
    value: requireUint(transaction.value, `${label}.value`),
    data: transaction.data ?? transaction.input,
  };
}

function normalizeReceipt(receipt, label) {
  if (!receipt || typeof receipt !== "object") {
    fail("INVALID_RECEIPT", `${label} is required`);
  }
  if (!Array.isArray(receipt.logs)) {
    fail("INVALID_RECEIPT", `${label}.logs must be an array`);
  }
  return {
    hash: normalizeHash(receipt.hash ?? receipt.transactionHash, `${label}.transactionHash`),
    from: normalizeAddress(receipt.from, `${label}.from`),
    to: normalizeAddress(receipt.to, `${label}.to`),
    blockNumber: requireSafePositiveUint(receipt.blockNumber, `${label}.blockNumber`),
    status: requireSafeUint(receipt.status, `${label}.status`),
    logs: receipt.logs.map((log, index) => normalizeLog(log, `${label}.logs[${index}]`)),
  };
}

function normalizeLog(log, label) {
  if (!log || typeof log !== "object" || !Array.isArray(log.topics) || log.topics.length === 0) {
    fail("INVALID_RECEIPT", `${label} is not a complete EVM log`);
  }
  if (log.removed === true) fail("INVALID_RECEIPT", `${label} was removed from the canonical chain`);
  return {
    address: normalizeAddress(log.address, `${label}.address`),
    topics: log.topics.map((topic, index) => normalizeHash(topic, `${label}.topics[${index}]`)),
    data: normalizeData(log.data, `${label}.data`),
  };
}

function validateTransactionReceiptBinding(transaction, receipt, label) {
  equal(receipt.hash, transaction.hash, `${label} receipt transaction hash`);
  equal(receipt.from, transaction.from, `${label} receipt sender`);
  equal(receipt.to, transaction.to, `${label} receipt target`);
  equal(receipt.blockNumber, transaction.blockNumber, `${label} receipt block`);
  if (receipt.status !== 0 && receipt.status !== 1) {
    fail("INVALID_RECEIPT", `${label} receipt status must be zero or one`);
  }
}

function normalizeMintParams(value, label = "mintParams") {
  if (!value || typeof value !== "object") fail("INVALID_MINT_PARAMS", `${label} is required`);
  return {
    mintPrice: requireUint(value.mintPrice ?? value[0], `${label}.mintPrice`),
    maxTotalMintableByWallet: requireUint(
      value.maxTotalMintableByWallet ?? value[1],
      `${label}.maxTotalMintableByWallet`,
    ),
    startTime: requireUint(value.startTime ?? value[2], `${label}.startTime`),
    endTime: requireUint(value.endTime ?? value[3], `${label}.endTime`),
    dropStageIndex: requireUint(value.dropStageIndex ?? value[4], `${label}.dropStageIndex`),
    maxTokenSupplyForStage: requireUint(
      value.maxTokenSupplyForStage ?? value[5],
      `${label}.maxTokenSupplyForStage`,
    ),
    feeBps: requireUint(value.feeBps ?? value[6], `${label}.feeBps`),
    restrictFeeRecipients: requireBoolean(
      value.restrictFeeRecipients ?? value[7],
      `${label}.restrictFeeRecipients`,
    ),
  };
}

function mintParamsAsTuple(params) {
  return MINT_PARAM_FIELDS.map((field) => params[field]);
}

function stringifyMintParams(params) {
  return Object.fromEntries(
    MINT_PARAM_FIELDS.map((field) => [
      field,
      typeof params[field] === "bigint" ? params[field].toString() : params[field],
    ]),
  );
}

function hashStableAction(mint, value) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "address",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "bool",
        "uint256",
      ],
      [
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
        mint.mintParams.restrictFeeRecipients,
        value,
      ],
    ),
  );
}

function hashContractAction({
  sourceChainId,
  seaDrop,
  beneficiary,
  failureBlock,
  successBlock,
  failureNonce,
  successNonce,
  mint,
}) {
  const semanticHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "address",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "bool",
      ],
      [
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
        mint.mintParams.restrictFeeRecipients,
      ],
    ),
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint64", "address", "address", "uint64", "uint64", "uint64", "uint64", "bytes32"],
      [
        "RETRYCREDIT_SEADROP_PAID_RETRY_V1",
        sourceChainId,
        seaDrop,
        beneficiary,
        failureBlock,
        successBlock,
        failureNonce,
        successNonce,
        semanticHash,
      ],
    ),
  );
}

function parseLog(iface, log, expectedName) {
  try {
    const parsed = iface.parseLog(log);
    if (!parsed || parsed.name !== expectedName) throw new Error(`expected ${expectedName}`);
    return parsed;
  } catch (error) {
    throw new SeaDropRecoveryError(
      "INVALID_SUCCESS",
      `${expectedName} log is not canonically encoded`,
      error,
    );
  }
}

function parseCalldataSuffix(data, canonical, signatureLength) {
  const actual = data.toLowerCase();
  const expected = canonical.toLowerCase();
  if (actual === expected) return "0x";
  if (
    signatureLength === 65
    && actual === `${expected}${OPEN_SEA_CALLDATA_SUFFIX.slice(2)}`
  ) {
    return OPEN_SEA_CALLDATA_SUFFIX;
  }
  fail("NON_CANONICAL_CALLDATA", "mintSigned calldata has unsupported ABI padding or trailing data");
}

function normalizeCalldataSuffix(value) {
  if (value === "0x") return value;
  if (typeof value === "string" && value.toLowerCase() === OPEN_SEA_CALLDATA_SUFFIX) {
    return OPEN_SEA_CALLDATA_SUFFIX;
  }
  fail("INVALID_PROFILE", "profile.calldataSuffix must be empty or the OpenSea attribution marker");
}

function normalizeAddress(value, label) {
  try {
    return ethers.getAddress(value);
  } catch (error) {
    throw new SeaDropRecoveryError("INVALID_ADDRESS", `${label} must be a valid address`, error);
  }
}

function normalizeHash(value, label) {
  if (typeof value !== "string" || !ethers.isHexString(value, 32)) {
    fail("INVALID_HASH", `${label} must be 32 bytes`);
  }
  return value.toLowerCase();
}

function normalizeData(value, label) {
  if (typeof value !== "string" || !ethers.isHexString(value)) {
    fail("INVALID_DATA", `${label} must be hex data`);
  }
  return value.toLowerCase();
}

function requireUint(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch (error) {
    throw new SeaDropRecoveryError("INVALID_UINT", `${label} must be an unsigned integer`, error);
  }
}

function requirePositiveUint(value, label) {
  const parsed = requireUint(value, label);
  if (parsed === 0n) fail("INVALID_UINT", `${label} must be greater than zero`);
  return parsed;
}

function requireSafeUint(value, label) {
  const parsed = requireUint(value, label);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("INVALID_UINT", `${label} exceeds the safe integer range`);
  }
  return Number(parsed);
}

function requireSafePositiveUint(value, label) {
  const parsed = requireSafeUint(value, label);
  if (parsed <= 0) fail("INVALID_UINT", `${label} must be greater than zero`);
  return parsed;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail("INVALID_BOOLEAN", `${label} must be boolean`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    fail("SEMANTIC_MISMATCH", `${label} mismatch`);
  }
}

function outcomeEqual(actual, expected, label) {
  if (actual !== expected) {
    fail("INVALID_SUCCESS", `${label} mismatch`);
  }
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function fail(code, message) {
  throw new SeaDropRecoveryError(code, message);
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}
