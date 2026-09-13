// Next's dev server rejects cross-origin requests unless the host is listed
// here, which is what breaks phone testing: a LAN address or a tunnel hostname
// is never the loopback origin the laptop uses. Derive the list instead of
// hard-coding it -- PUBLIC_ORIGIN is already the one exact public URL the
// Fastify side checks against, and DEV_ORIGINS carries any extras (LAN IPs,
// wildcards) without a code edit per network.
const devOrigins = [
  ...(process.env.DEV_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
];
try {
  const { hostname } = new URL(process.env.PUBLIC_ORIGIN);
  if (hostname && !devOrigins.includes(hostname)) devOrigins.push(hostname);
} catch {
  // PUBLIC_ORIGIN unset or not a URL: loopback development, nothing to allow.
}

export default {
  poweredByHeader: false,
  allowedDevOrigins: devOrigins,
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
