// Ambient shim for @typescript-eslint/parser v8: the package is exports-map-only, which
// `moduleResolution: "node"` cannot resolve (TS2307). The runtime import works fine; `any` suffices here.
declare module '@typescript-eslint/parser'
