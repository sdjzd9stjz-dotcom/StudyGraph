CREATE TABLE "CanvasReasoningPref" (
    "canvasId" TEXT NOT NULL REFERENCES "Canvas"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "scope" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    PRIMARY KEY ("canvasId", "scope")
);
