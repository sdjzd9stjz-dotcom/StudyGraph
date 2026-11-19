/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 允许 import apps/web 之外的源码（packages/contracts 的端口矩阵）。
  // 端口类型必须前后端同源，不能为了让 Next 好打包就复制一份。
  experimental: {
    externalDir: true,
  },
}

export default nextConfig
