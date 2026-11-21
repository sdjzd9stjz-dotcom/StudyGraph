-- =============================================================================
-- 多供应商与 BYOK（规格「多供应商与 BYOK」）
-- =============================================================================
-- 为什么供应商是表而不是代码里的联合类型：校园网关、企业代理、本地 Ollama、
-- 各家 OpenAI 兼容端点，写死两三家覆盖不了。预置目录由运维维护（isCustom=false），
-- 学生自建端点 isCustom=true 且只属于自己（ownerId）。
--
-- DDL 由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成后手工裁剪，
-- 只保留本迁移新增的对象。

-- CreateEnum
CREATE TYPE "ProviderProtocol" AS ENUM ('OPENAI', 'ANTHROPIC', 'GEMINI');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('UNVERIFIED', 'VALID', 'INVALID', 'RATE_LIMITED');

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "ProviderProtocol" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "docsUrl" TEXT,
    "byokEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT,
    "keyRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderModel" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contextWindow" INTEGER NOT NULL DEFAULT 0,
    "maxOutput" INTEGER,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "inputPrice" DECIMAL(12,6),
    "outputPrice" DECIMAL(12,6),
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ProviderModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "ciphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "last4" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "baseUrlOverride" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserModelPref" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,

    CONSTRAINT "UserModelPref_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Provider_slug_key" ON "Provider"("slug");
CREATE INDEX "Provider_ownerId_idx" ON "Provider"("ownerId");
CREATE INDEX "ProviderModel_providerId_idx" ON "ProviderModel"("providerId");
CREATE UNIQUE INDEX "ProviderModel_providerId_modelId_key" ON "ProviderModel"("providerId", "modelId");
CREATE INDEX "UserCredential_userId_idx" ON "UserCredential"("userId");
CREATE UNIQUE INDEX "UserCredential_userId_providerId_label_key" ON "UserCredential"("userId", "providerId", "label");
CREATE INDEX "UserModelPref_userId_idx" ON "UserModelPref"("userId");
CREATE UNIQUE INDEX "UserModelPref_userId_taskType_key" ON "UserModelPref"("userId", "taskType");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderModel" ADD CONSTRAINT "ProviderModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCredential" ADD CONSTRAINT "UserCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserCredential" ADD CONSTRAINT "UserCredential_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserModelPref" ADD CONSTRAINT "UserModelPref_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserModelPref" ADD CONSTRAINT "UserModelPref_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "UserCredential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 预置厂商目录（规格「预置厂商目录」，首期至少这些）
-- =============================================================================
-- slug 稳定不变：自定义端点用 custom-<随机> 前缀，不与预置项冲突。
-- capabilities 不确定的一律留空对象 —— 规格要求「厂商未声明能力时允许选择，
-- 但打 UNTESTED 标记」，而不是瞎填 true。
INSERT INTO "Provider" ("id", "slug", "name", "protocol", "baseUrl", "docsUrl", "byokEnabled", "sortOrder", "isCustom", "keyRequired") VALUES
  ('prov_openai',      'openai',      'OpenAI',               'OPENAI',    'https://api.openai.com/v1',                         'https://platform.openai.com/api-keys',         true,  10, false, true),
  ('prov_deepseek',    'deepseek',    'DeepSeek',             'OPENAI',    'https://api.deepseek.com',                          'https://platform.deepseek.com/api_keys',       true,  20, false, true),
  ('prov_anthropic',   'anthropic',   'Anthropic',            'ANTHROPIC', 'https://api.anthropic.com',                         'https://console.anthropic.com/settings/keys',  true,  30, false, true),
  ('prov_gemini',      'gemini',      'Google Gemini',        'GEMINI',    'https://generativelanguage.googleapis.com',         'https://aistudio.google.com/app/apikey',       true,  40, false, true),
  ('prov_moonshot',    'moonshot',    'Moonshot / Kimi',      'OPENAI',    'https://api.moonshot.cn/v1',                        'https://platform.moonshot.cn/console/api-keys',true,  50, false, true),
  ('prov_zhipu',       'zhipu',       '智谱 GLM',             'OPENAI',    'https://open.bigmodel.cn/api/paas/v4',              'https://bigmodel.cn/usercenter/apikeys',       true,  60, false, true),
  ('prov_dashscope',   'dashscope',   '阿里通义 DashScope',   'OPENAI',    'https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://bailian.console.aliyun.com/?apiKey=1', true,  70, false, true),
  ('prov_siliconflow', 'siliconflow', '硅基流动 SiliconFlow', 'OPENAI',    'https://api.siliconflow.cn/v1',                     'https://cloud.siliconflow.cn/account/ak',      true,  80, false, true),
  ('prov_openrouter',  'openrouter',  'OpenRouter',           'OPENAI',    'https://openrouter.ai/api/v1',                      'https://openrouter.ai/keys',                   true,  90, false, true),
  ('prov_ollama',      'ollama',      'Ollama（本地）',       'OPENAI',    'http://localhost:11434/v1',                         'https://ollama.com/download',                  true, 100, false, false);

-- 常用模型：只填名称与上下文，能力与价格不确定的一律留空
INSERT INTO "ProviderModel" ("id", "providerId", "modelId", "displayName", "contextWindow", "capabilities") VALUES
  ('pm_ds_chat',     'prov_deepseek',    'deepseek-chat',             'DeepSeek Chat',     65536,  '{"jsonObject": true}'),
  ('pm_ds_reasoner', 'prov_deepseek',    'deepseek-reasoner',         'DeepSeek Reasoner', 65536,  '{"jsonObject": true, "reasoning": true}'),
  ('pm_oa_mini',     'prov_openai',      'gpt-4o-mini',               'GPT-4o mini',       128000, '{"jsonObject": true, "vision": true, "toolUse": true}'),
  ('pm_oa_4o',       'prov_openai',      'gpt-4o',                    'GPT-4o',            128000, '{"jsonObject": true, "vision": true, "toolUse": true}'),
  ('pm_an_sonnet',   'prov_anthropic',   'claude-sonnet-4-5',         'Claude Sonnet 4.5', 200000, '{"vision": true, "toolUse": true}'),
  ('pm_an_haiku',    'prov_anthropic',   'claude-haiku-4-5',          'Claude Haiku 4.5',  200000, '{"vision": true, "toolUse": true}'),
  ('pm_moon_8k',     'prov_moonshot',    'moonshot-v1-8k',            'Moonshot v1 8k',    8192,   '{}'),
  ('pm_glm_4',       'prov_zhipu',       'glm-4-plus',                'GLM-4 Plus',        128000, '{"jsonObject": true}'),
  ('pm_ds_qwen',     'prov_dashscope',   'qwen-plus',                 'Qwen Plus',         131072, '{"jsonObject": true}'),
  ('pm_sf_qwen',     'prov_siliconflow', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen2.5 72B (SF)',  32768,  '{"jsonObject": true}'),
  ('pm_ol_llama',    'prov_ollama',      'llama3.1',                  'Llama 3.1 (本地)',  131072, '{}');
