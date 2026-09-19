// The worker runs with nodejs_compat, which provides node:buffer natively.
// @cloudflare/workers-types doesn't describe it, so the one shape used - a
// byte-safe base64 encode - is declared here rather than pulling in the whole
// of @types/node, whose globals fight the workers types.
declare module "node:buffer" {
  export const Buffer: {
    from(data: ArrayBufferView | ArrayBuffer | string): { toString(encoding: string): string };
  };
}
