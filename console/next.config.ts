import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone', // small runtime image (see Dockerfile)
  poweredByHeader: false,
};
export default config;
