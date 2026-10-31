export function resourcePreviewAssets(): {
  name: string;
  configResolved(config: { base: string }): void;
  generateBundle(): void;
  configureServer(server: unknown): void;
};
