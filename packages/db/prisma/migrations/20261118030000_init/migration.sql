-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "NodeType" AS ENUM ('SOURCE', 'CHUNK', 'EXTRACT', 'CARD', 'PREREQ', 'QUIZ', 'GRADE', 'REVIEW', 'GATE', 'PROBE', 'METHOD', 'SOLVE', 'DIAGNOSE', 'VARIANT', 'DISTRACTOR', 'CHECK', 'PAPER');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'STALE', 'ERROR');

-- CreateEnum
CREATE TYPE "EdgeKind" AS ENUM ('DERIVED_FROM', 'PREREQUISITE', 'CITES');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SOURCE_TEXT', 'SPAN_INDEX', 'CHUNKS', 'CONCEPT_CLAIMS', 'CONCEPT_CARD', 'PREREQ_PROPOSAL', 'PROBLEM_DRAFT', 'GRADING', 'REVIEW_PLAN', 'COST_ESTIMATE', 'PROBE_PROFILE', 'METHOD_CARD', 'SOLUTION_TRACE', 'DIAGNOSIS', 'VARIANT_SET', 'DISTRACTOR_SET', 'CHECK_VERDICT', 'PAPER_SPEC', 'OUTLINE_SKELETON', 'DRAFT_SKELETON');

-- CreateEnum
CREATE TYPE "ConceptEdgeKind" AS ENUM ('PREREQUISITE', 'CONTRAST', 'CONTAINS', 'APPLIES_TO', 'VARIANT_OF');

-- CreateEnum
CREATE TYPE "MethodEdgeKind" AS ENUM ('SPECIALIZES', 'COMBINES_WITH', 'CONTRASTS_WITH');

-- CreateEnum
CREATE TYPE "EdgeReviewStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'MERGED');

-- CreateEnum
CREATE TYPE "ProblemType" AS ENUM ('SINGLE_CHOICE', 'MULTI_CHOICE', 'TRUE_FALSE', 'FILL_BLANK', 'NUMERIC', 'COMPUTATION', 'SHORT_ANSWER', 'PROOF');

-- CreateEnum
CREATE TYPE "JudgeRule" AS ENUM ('EXACT', 'NUMERIC_TOL', 'RUBRIC', 'CHOICE');

-- CreateEnum
CREATE TYPE "BloomLevel" AS ENUM ('REMEMBER', 'UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE', 'CREATE');

-- CreateEnum
CREATE TYPE "ProblemStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('CONCEPT_GAP', 'METHOD_MISMATCH', 'CONDITION_MISSED', 'COMPUTE_SLIP', 'READING_SLIP', 'CHECK_OMITTED');

-- CreateEnum
CREATE TYPE "RoleInProblem" AS ENUM ('REQUIRED', 'OPTIONAL', 'DECOY');

-- CreateEnum
CREATE TYPE "VariantAxis" AS ENUM ('NUMERIC', 'CONTEXT', 'CONDITION', 'DIRECTION', 'REPRESENTATION', 'COMPOSITE');

-- CreateEnum
CREATE TYPE "CanvasVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateEnum
CREATE TYPE "CanvasView" AS ENUM ('PIPELINE', 'KNOWLEDGE', 'METHOD');

-- CreateEnum
CREATE TYPE "CanvasRole" AS ENUM ('EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "Scope" AS ENUM ('CANVAS_READ', 'CANVAS_WRITE', 'RUN_EXECUTE', 'PROBLEM_READ');

-- CreateEnum
CREATE TYPE "WebhookEvent" AS ENUM ('NODE_RUN_COMPLETED', 'CONCEPT_MASTERY_CHANGED', 'METHOD_PROFICIENCY_CHANGED', 'REVIEW_DUE', 'PROBLEM_REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'EXHAUSTED');

-- CreateEnum
CREATE TYPE "ReviewGrade" AS ENUM ('AGAIN', 'HARD', 'GOOD', 'EASY');

-- CreateEnum
CREATE TYPE "FsrsCardState" AS ENUM ('NEW', 'LEARNING', 'REVIEW', 'RELEARNING');

-- CreateEnum
CREATE TYPE "UsageSurface" AS ENUM ('NODE_RUN', 'CHAT_COMPLETIONS', 'MCP');

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('PDF', 'PPTX', 'WEB', 'AUDIO', 'IMAGE', 'TEXT');

-- CreateEnum
CREATE TYPE "PaperStatus" AS ENUM ('DRAFT', 'READY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalAccessToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" "Scope"[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "scopes" "Scope"[],
    "isFirstParty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Canvas" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "CanvasVisibility" NOT NULL DEFAULT 'PRIVATE',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "forkedFromId" TEXT,
    "forkCount" INTEGER NOT NULL DEFAULT 0,
    "originAuthorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Canvas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanvasMember" (
    "canvasId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "CanvasRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanvasMember_pkey" PRIMARY KEY ("canvasId","userId")
);

-- CreateTable
CREATE TABLE "CanvasDoc" (
    "canvasId" TEXT NOT NULL,
    "ystate" BYTEA NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanvasDoc_pkey" PRIMARY KEY ("canvasId")
);

-- CreateTable
CREATE TABLE "CanvasViewLayout" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "view" "CanvasView" NOT NULL,
    "layout" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanvasViewLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Node" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "type" "NodeType" NOT NULL,
    "title" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "NodeStatus" NOT NULL DEFAULT 'DRAFT',
    "fingerprint" TEXT,
    "posX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edge" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "kind" "EdgeKind" NOT NULL,
    "fromPort" TEXT NOT NULL DEFAULT 'out',
    "toPort" TEXT NOT NULL DEFAULT 'in',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" TEXT NOT NULL DEFAULT 'user',
    "modelUsed" TEXT,
    "modelVersion" TEXT,
    "promptVersion" TEXT,
    "fingerprint" TEXT,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "estimatedTokensIn" INTEGER,
    "estimatedTokensOut" INTEGER,
    "costUsd" DECIMAL(12,6),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" "ArtifactKind" NOT NULL,
    "s3Key" TEXT,
    "structured" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "byteSize" INTEGER,
    "s3Key" TEXT,
    "checksum" TEXT,
    "parsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Span" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "bbox" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Span_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" TEXT NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "mastery" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReviewedAt" TIMESTAMP(3),
    "reps" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "fsrsState" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1536),
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "createdFromNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptCitation" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "quote" TEXT,

    CONSTRAINT "ConceptCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptEdge" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "fromConceptId" TEXT NOT NULL,
    "toConceptId" TEXT NOT NULL,
    "kind" "ConceptEdgeKind" NOT NULL,
    "status" "EdgeReviewStatus" NOT NULL DEFAULT 'PROPOSED',
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT,
    "evidenceSourceId" TEXT,
    "evidenceSpanId" TEXT,
    "createdFromNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConceptEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConceptReview" (
    "id" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grade" "ReviewGrade" NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "elapsedDays" DOUBLE PRECISION NOT NULL,
    "scheduledDays" DOUBLE PRECISION NOT NULL,
    "stabilityBefore" DOUBLE PRECISION,
    "stabilityAfter" DOUBLE PRECISION,
    "difficultyBefore" DOUBLE PRECISION,
    "difficultyAfter" DOUBLE PRECISION,
    "state" "FsrsCardState" NOT NULL,
    "masteryAfter" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "ConceptReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Method" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT,
    "status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "proficiency" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdFromNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodCitation" (
    "id" TEXT NOT NULL,
    "methodId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "stepOrder" INTEGER,
    "quote" TEXT,

    CONSTRAINT "MethodCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodConcept" (
    "methodId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "isCore" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MethodConcept_pkey" PRIMARY KEY ("methodId","conceptId")
);

-- CreateTable
CREATE TABLE "MethodEdge" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "fromMethodId" TEXT NOT NULL,
    "toMethodId" TEXT NOT NULL,
    "kind" "MethodEdgeKind" NOT NULL,
    "status" "EdgeReviewStatus" NOT NULL DEFAULT 'CONFIRMED',
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MethodApplication" (
    "id" TEXT NOT NULL,
    "methodId" TEXT NOT NULL,
    "problemId" TEXT,
    "attemptId" TEXT,
    "userId" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL,
    "isTransfer" BOOLEAN NOT NULL DEFAULT false,
    "isMisuse" BOOLEAN NOT NULL DEFAULT false,
    "contextKey" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MethodApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "type" "ProblemType" NOT NULL,
    "stemMd" TEXT NOT NULL,
    "stemMathml" TEXT,
    "options" JSONB,
    "answer" JSONB NOT NULL,
    "judgeRule" "JudgeRule" NOT NULL,
    "judgeSpec" JSONB,
    "difficulty" INTEGER NOT NULL DEFAULT 1,
    "bloom" "BloomLevel" NOT NULL DEFAULT 'APPLY',
    "status" "ProblemStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "checkResult" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "sourceNodeId" TEXT,
    "createdFromRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemCitation" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "ProblemCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemConcept" (
    "problemId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "weight" DOUBLE PRECISION,

    CONSTRAINT "ProblemConcept_pkey" PRIMARY KEY ("problemId","conceptId")
);

-- CreateTable
CREATE TABLE "ProblemMethod" (
    "problemId" TEXT NOT NULL,
    "methodId" TEXT NOT NULL,
    "role" "RoleInProblem" NOT NULL,

    CONSTRAINT "ProblemMethod_pkey" PRIMARY KEY ("problemId","methodId")
);

-- CreateTable
CREATE TABLE "Attempt" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "isCorrect" BOOLEAN,
    "errorTags" JSONB NOT NULL DEFAULT '[]',
    "judgeDetail" JSONB,
    "timeSpentSec" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorTag" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" "ErrorCategory" NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paper" (
    "id" TEXT NOT NULL,
    "canvasId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "report" JSONB,
    "durationMin" INTEGER,
    "status" "PaperStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Paper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperItem" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "PaperItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "canvasId" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" "WebhookEvent"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" "WebhookEvent" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canvasId" TEXT,
    "runId" TEXT,
    "surface" "UsageSurface" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "keyCiphertext" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_tokenHash_key" ON "PersonalAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_userId_idx" ON "PersonalAccessToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "OAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "Canvas_ownerId_idx" ON "Canvas"("ownerId");

-- CreateIndex
CREATE INDEX "Canvas_visibility_isTemplate_idx" ON "Canvas"("visibility", "isTemplate");

-- CreateIndex
CREATE INDEX "CanvasMember_userId_idx" ON "CanvasMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CanvasViewLayout_canvasId_view_key" ON "CanvasViewLayout"("canvasId", "view");

-- CreateIndex
CREATE INDEX "Node_canvasId_type_idx" ON "Node"("canvasId", "type");

-- CreateIndex
CREATE INDEX "Node_canvasId_status_idx" ON "Node"("canvasId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Node_canvasId_id_key" ON "Node"("canvasId", "id");

-- CreateIndex
CREATE INDEX "Edge_canvasId_idx" ON "Edge"("canvasId");

-- CreateIndex
CREATE INDEX "Edge_toNodeId_idx" ON "Edge"("toNodeId");

-- CreateIndex
CREATE INDEX "Edge_fromNodeId_idx" ON "Edge"("fromNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Edge_canvasId_fromNodeId_toNodeId_kind_key" ON "Edge"("canvasId", "fromNodeId", "toNodeId", "kind");

-- CreateIndex
CREATE INDEX "Run_nodeId_createdAt_idx" ON "Run"("nodeId", "createdAt");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Artifact_nodeId_kind_idx" ON "Artifact"("nodeId", "kind");

-- CreateIndex
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");

-- CreateIndex
CREATE INDEX "Artifact_hash_idx" ON "Artifact"("hash");

-- CreateIndex
CREATE INDEX "Source_nodeId_idx" ON "Source"("nodeId");

-- CreateIndex
CREATE INDEX "Source_checksum_idx" ON "Source"("checksum");

-- CreateIndex
CREATE INDEX "Span_sourceId_page_idx" ON "Span"("sourceId", "page");

-- CreateIndex
CREATE UNIQUE INDEX "Span_sourceId_page_charStart_charEnd_key" ON "Span"("sourceId", "page", "charStart", "charEnd");

-- CreateIndex
CREATE INDEX "Concept_canvasId_dueAt_idx" ON "Concept"("canvasId", "dueAt");

-- CreateIndex
CREATE INDEX "Concept_canvasId_status_idx" ON "Concept"("canvasId", "status");

-- CreateIndex
CREATE INDEX "Concept_canvasId_mastery_idx" ON "Concept"("canvasId", "mastery");

-- CreateIndex
CREATE UNIQUE INDEX "Concept_canvasId_name_key" ON "Concept"("canvasId", "name");

-- CreateIndex
CREATE INDEX "ConceptCitation_spanId_idx" ON "ConceptCitation"("spanId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptCitation_conceptId_spanId_key" ON "ConceptCitation"("conceptId", "spanId");

-- CreateIndex
CREATE INDEX "ConceptEdge_canvasId_kind_status_idx" ON "ConceptEdge"("canvasId", "kind", "status");

-- CreateIndex
CREATE INDEX "ConceptEdge_fromConceptId_idx" ON "ConceptEdge"("fromConceptId");

-- CreateIndex
CREATE INDEX "ConceptEdge_toConceptId_idx" ON "ConceptEdge"("toConceptId");

-- CreateIndex
CREATE UNIQUE INDEX "ConceptEdge_fromConceptId_toConceptId_kind_key" ON "ConceptEdge"("fromConceptId", "toConceptId", "kind");

-- CreateIndex
CREATE INDEX "ConceptReview_conceptId_reviewedAt_idx" ON "ConceptReview"("conceptId", "reviewedAt");

-- CreateIndex
CREATE INDEX "ConceptReview_userId_reviewedAt_idx" ON "ConceptReview"("userId", "reviewedAt");

-- CreateIndex
CREATE INDEX "Method_canvasId_proficiency_idx" ON "Method"("canvasId", "proficiency");

-- CreateIndex
CREATE INDEX "Method_canvasId_status_idx" ON "Method"("canvasId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Method_canvasId_name_key" ON "Method"("canvasId", "name");

-- CreateIndex
CREATE INDEX "MethodCitation_spanId_idx" ON "MethodCitation"("spanId");

-- CreateIndex
CREATE UNIQUE INDEX "MethodCitation_methodId_spanId_key" ON "MethodCitation"("methodId", "spanId");

-- CreateIndex
CREATE INDEX "MethodConcept_conceptId_idx" ON "MethodConcept"("conceptId");

-- CreateIndex
CREATE INDEX "MethodEdge_canvasId_kind_idx" ON "MethodEdge"("canvasId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MethodEdge_fromMethodId_toMethodId_kind_key" ON "MethodEdge"("fromMethodId", "toMethodId", "kind");

-- CreateIndex
CREATE INDEX "MethodApplication_methodId_usedAt_idx" ON "MethodApplication"("methodId", "usedAt");

-- CreateIndex
CREATE INDEX "MethodApplication_userId_usedAt_idx" ON "MethodApplication"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "Problem_canvasId_status_idx" ON "Problem"("canvasId", "status");

-- CreateIndex
CREATE INDEX "Problem_canvasId_difficulty_idx" ON "Problem"("canvasId", "difficulty");

-- CreateIndex
CREATE INDEX "Problem_canvasId_type_idx" ON "Problem"("canvasId", "type");

-- CreateIndex
CREATE INDEX "ProblemCitation_spanId_idx" ON "ProblemCitation"("spanId");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemCitation_problemId_spanId_key" ON "ProblemCitation"("problemId", "spanId");

-- CreateIndex
CREATE INDEX "ProblemConcept_conceptId_idx" ON "ProblemConcept"("conceptId");

-- CreateIndex
CREATE INDEX "ProblemMethod_methodId_idx" ON "ProblemMethod"("methodId");

-- CreateIndex
CREATE INDEX "Attempt_problemId_idx" ON "Attempt"("problemId");

-- CreateIndex
CREATE INDEX "Attempt_userId_createdAt_idx" ON "Attempt"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ErrorTag_code_key" ON "ErrorTag"("code");

-- CreateIndex
CREATE INDEX "ErrorTag_category_idx" ON "ErrorTag"("category");

-- CreateIndex
CREATE INDEX "Paper_canvasId_createdAt_idx" ON "Paper"("canvasId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperItem_paperId_order_idx" ON "PaperItem"("paperId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "PaperItem_paperId_problemId_key" ON "PaperItem"("paperId", "problemId");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_ownerId_idx" ON "WebhookEndpoint"("ownerId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "UsageRecord_userId_createdAt_idx" ON "UsageRecord"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_runId_idx" ON "UsageRecord"("runId");

-- CreateIndex
CREATE INDEX "ProviderCredential_userId_idx" ON "ProviderCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_userId_provider_label_key" ON "ProviderCredential"("userId", "provider", "label");

-- AddForeignKey
ALTER TABLE "PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Canvas" ADD CONSTRAINT "Canvas_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Canvas" ADD CONSTRAINT "Canvas_forkedFromId_fkey" FOREIGN KEY ("forkedFromId") REFERENCES "Canvas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasMember" ADD CONSTRAINT "CanvasMember_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasMember" ADD CONSTRAINT "CanvasMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasDoc" ADD CONSTRAINT "CanvasDoc_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanvasViewLayout" ADD CONSTRAINT "CanvasViewLayout_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_canvasId_fromNodeId_fkey" FOREIGN KEY ("canvasId", "fromNodeId") REFERENCES "Node"("canvasId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_canvasId_toNodeId_fkey" FOREIGN KEY ("canvasId", "toNodeId") REFERENCES "Node"("canvasId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Span" ADD CONSTRAINT "Span_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Concept" ADD CONSTRAINT "Concept_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptCitation" ADD CONSTRAINT "ConceptCitation_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptCitation" ADD CONSTRAINT "ConceptCitation_spanId_fkey" FOREIGN KEY ("spanId") REFERENCES "Span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_fromConceptId_fkey" FOREIGN KEY ("fromConceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_toConceptId_fkey" FOREIGN KEY ("toConceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_evidenceSourceId_fkey" FOREIGN KEY ("evidenceSourceId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptEdge" ADD CONSTRAINT "ConceptEdge_evidenceSpanId_fkey" FOREIGN KEY ("evidenceSpanId") REFERENCES "Span"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptReview" ADD CONSTRAINT "ConceptReview_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConceptReview" ADD CONSTRAINT "ConceptReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Method" ADD CONSTRAINT "Method_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodCitation" ADD CONSTRAINT "MethodCitation_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodCitation" ADD CONSTRAINT "MethodCitation_spanId_fkey" FOREIGN KEY ("spanId") REFERENCES "Span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodConcept" ADD CONSTRAINT "MethodConcept_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodConcept" ADD CONSTRAINT "MethodConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodEdge" ADD CONSTRAINT "MethodEdge_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodEdge" ADD CONSTRAINT "MethodEdge_fromMethodId_fkey" FOREIGN KEY ("fromMethodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodEdge" ADD CONSTRAINT "MethodEdge_toMethodId_fkey" FOREIGN KEY ("toMethodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodApplication" ADD CONSTRAINT "MethodApplication_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodApplication" ADD CONSTRAINT "MethodApplication_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodApplication" ADD CONSTRAINT "MethodApplication_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MethodApplication" ADD CONSTRAINT "MethodApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemCitation" ADD CONSTRAINT "ProblemCitation_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemCitation" ADD CONSTRAINT "ProblemCitation_spanId_fkey" FOREIGN KEY ("spanId") REFERENCES "Span"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemConcept" ADD CONSTRAINT "ProblemConcept_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemConcept" ADD CONSTRAINT "ProblemConcept_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "Concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemMethod" ADD CONSTRAINT "ProblemMethod_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemMethod" ADD CONSTRAINT "ProblemMethod_methodId_fkey" FOREIGN KEY ("methodId") REFERENCES "Method"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paper" ADD CONSTRAINT "Paper_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperItem" ADD CONSTRAINT "PaperItem_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperItem" ADD CONSTRAINT "PaperItem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
