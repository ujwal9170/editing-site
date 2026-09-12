export default {
  poweredByHeader: false,
  experimental: {
    // Next.js's own proxy layer (used for the /api/* rewrite below) buffers
    // request bodies independently of the Fastify backend's own bodyLimit
    // settings, capped at 10MB by default -- silently, with no error to the
    // client, just a truncated body. Media uploads (up to 300MB) and
    // device-rendered exports both exceed that by far.
    proxyClientMaxBodySize: "320mb",
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${process.env.API_PORT || 4175}/api/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};
