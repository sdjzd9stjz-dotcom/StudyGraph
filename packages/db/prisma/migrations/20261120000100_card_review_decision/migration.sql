CREATE TYPE "CardReviewDecision" AS ENUM ('ACCEPT', 'REJECT');
ALTER TABLE "Concept" ADD COLUMN "reviewDecision" "CardReviewDecision";
ALTER TABLE "Method" ADD COLUMN "reviewDecision" "CardReviewDecision";

-- An older reviewed UNVERIFIED row may have been rejected or downgraded by inspection.
-- Preserve that ambiguity and its reviewer; only a confirmed acceptance can be backfilled.
UPDATE "Concept" SET "reviewDecision" = 'ACCEPT'
WHERE "reviewedBy" IS NOT NULL AND "status" = 'VERIFIED';
UPDATE "Method" SET "reviewDecision" = 'ACCEPT'
WHERE "reviewedBy" IS NOT NULL AND "status" = 'VERIFIED';
