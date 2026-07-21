import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `subset-font` loads harfbuzz from a .wasm file inside node_modules. Letting
  // the server bundler process it rewrites that path, so the file can't be
  // found at runtime and the schedule PDF's CJK subsetting fails. Keeping the
  // package external makes it resolve from node_modules as-is.
  serverExternalPackages: ["subset-font"],
};

export default nextConfig;
