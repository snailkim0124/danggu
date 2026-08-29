import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@techstark/opencv-js` ships OpenCV.js as a single ~13MB file with the
  // WASM binary embedded directly in it (no separate .wasm asset — verified
  // by requiring it directly: it initializes standalone with no filesystem
  // access beyond its own module file). Because it's plain CommonJS/UMD and
  // self-contained, no webpack `experiments.asyncWebAssembly`/wasm loader
  // config is needed. What IS needed: opting it OUT of Next's Server
  // Components/Route Handler bundling, so Next does a plain Node `require()`
  // from node_modules at runtime instead of feeding an already-minified
  // 13MB file (with embedded binary data) through webpack/Turbopack. Without
  // this, builds get slower and the function bundle carries a needlessly
  // re-processed copy of the file. (`mongoose` and `sharp`, also used in
  // this project, are already on Next's built-in default-external list, so
  // they don't need to be listed here.)
  //
  // This package must only be `require()`d from Node.js-runtime code (the
  // default for Route Handlers) — never from `export const runtime = 'edge'`
  // routes or middleware, since the Edge runtime has no Node.js `require`/
  // `module` and can't load it. See docs/deployment.md.
  serverExternalPackages: ["@techstark/opencv-js"],
};

export default nextConfig;
