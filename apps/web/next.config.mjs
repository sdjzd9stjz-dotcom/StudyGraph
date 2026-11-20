/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 桌面客户端用：产出 .next/standalone（自带 server.js 与最小依赖），
  // 不依赖用户机器上装 node_modules。Web 形态照常 next start，两者共存。
  output: 'standalone',
  // 允许 import apps/web 之外的源码（packages/contracts 的端口矩阵）。
  // 端口类型必须前后端同源，不能为了让 Next 好打包就复制一份。
  experimental: {
    externalDir: true,
  },
}

export default nextConfig
