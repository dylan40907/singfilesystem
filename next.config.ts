import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `subset-font` loads harfbuzz from a .wasm file inside node_modules. Letting
  // the server bundler process it rewrites that path, so the file can't be
  // found at runtime and the schedule PDF's CJK subsetting fails. Keeping the
  // package external makes it resolve from node_modules as-is.
  serverExternalPackages: ["subset-font"],

  async headers() {
    return [
      {
        // The booking pages are embedded in the Squarespace site, so they must
        // be framable — but only by us, not by anyone who fancies putting our
        // form on their page.
        source: "/book/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://*.singinchinese.com https://singinchinese.com " +
              "https://*.squarespace.com https://*.singlearning.com https://singlearning.com;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
