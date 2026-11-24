-- 分组记住自己的收起状态。
--
-- 为什么要存库：收起/展开原先只存在前端 state 里，重新进画布就全部变回展开，
-- 用户看到的是"组自动解开了"（真实反馈）。状态是组的属性，不是界面的临时状态。
ALTER TABLE "NodeGroup" ADD COLUMN IF NOT EXISTS "collapsed" BOOLEAN NOT NULL DEFAULT false;
