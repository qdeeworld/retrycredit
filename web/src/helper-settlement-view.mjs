import { helperOperationIsTerminal } from "./recovery-helper-state.mjs";

export function helperSettlementConfirmed(operation) {
  return operation?.state === "settled" && operation.receiptCheck === "confirmed";
}

// Backend terminality and a user-visible, reconciled outcome are distinct.
export function helperOutcomeResolved(operation) {
  return helperOperationIsTerminal(operation)
    && (operation.state !== "settled" || helperSettlementConfirmed(operation))
    && operation.receiptCheck !== "conflict";
}
