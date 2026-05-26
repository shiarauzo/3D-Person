import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read the exact installed @mediapipe/tasks-vision version at build time.
// We use readFileSync with an absolute path because the package's exports map
// does not expose ./package.json, so require() and static imports both fail
// the module resolver.  Reading the file directly in the Node.js config context
// bypasses the exports constraint and gives us the pinned version string.
const mpPkgPath = resolve(
  __dirname,
  "node_modules/@mediapipe/tasks-vision/package.json"
);
const { version: MP_VERSION } = JSON.parse(readFileSync(mpPkgPath, "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Embedded at build time so CDN fallback URL matches installed package.
    NEXT_PUBLIC_MP_VERSION: MP_VERSION,
  },
};

export default nextConfig;
