CREATE TABLE "CanvasEdit" (
  "seq" bigserial PRIMARY KEY,
  "canvasId" text NOT NULL REFERENCES "Canvas"(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "undone" boolean NOT NULL DEFAULT false,
  "label" text NOT NULL,
  "targets" jsonb NOT NULL,
  "snapshot" jsonb NOT NULL
);
CREATE INDEX "CanvasEdit_stack_idx" ON "CanvasEdit"("canvasId", "userId", "seq");
