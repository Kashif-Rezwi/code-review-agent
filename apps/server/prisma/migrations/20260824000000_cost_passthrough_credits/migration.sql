-- Cost-passthrough credit system: switch credits to hundredths (100 = 1 credit = ₹1)
-- and add the SETTLEMENT ledger entry type used to refund unused reservation on success.
--
-- Data migration: scale all existing credit quantities ×100. No column TYPE changes —
-- only the semantic scale changes, so existing rows keep their meaning in the new unit.
-- Safe to run on a populated database; reversible by dividing by 100.

-- 1. New ledger entry type for settlement refunds.
ALTER TYPE "LedgerEntryType" ADD VALUE 'SETTLEMENT';

-- 2. Scale existing balances and ledger history to hundredths.
UPDATE "User" SET "creditBalance" = "creditBalance" * 100;
UPDATE "CreditLedger" SET "amount" = "amount" * 100, "balanceAfter" = "balanceAfter" * 100;

-- 3. Pending (not yet captured) orders carry a creditsGranted computed under the old
--    whole-credit unit; rescale so a still-open checkout grants the right amount.
--    Captured/expired orders already granted their credits via the ledger rows scaled above.
UPDATE "PaymentOrder" SET "creditsGranted" = "creditsGranted" * 100 WHERE "status" = 'CREATED';

-- 4. Document the unit on the columns themselves.
COMMENT ON COLUMN "User"."creditBalance" IS 'Hundredths of a credit (100 = 1 credit = ₹1)';
COMMENT ON COLUMN "CreditLedger"."amount" IS 'Hundredths of a credit; positive = in, negative = out';
COMMENT ON COLUMN "CreditLedger"."balanceAfter" IS 'Hundredths of a credit; snapshot after entry';
COMMENT ON COLUMN "PaymentOrder"."creditsGranted" IS 'Hundredths of a credit (100 = 1 credit)';
