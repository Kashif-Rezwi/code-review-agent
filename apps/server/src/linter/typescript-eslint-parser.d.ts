// Ambient shim for @typescript-eslint/parser v8: the package is exports-map-only
// (no root main/types), which this project's `moduleResolution: "node"` tsconfig
// cannot resolve (TS2307). The runtime import works fine (Node reads exports maps);
// the linter casts the module namespace to LinterTypes.Parser, so `any` is sufficient.
declare module '@typescript-eslint/parser'
