/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable server-side modules (better-sqlite3 is a native module)
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;
