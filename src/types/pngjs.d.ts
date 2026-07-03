declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    constructor(opts: { width: number; height: number });
    static sync: {
      read(input: Buffer): PNG;
      write(input: PNG, options?: { colorType?: number }): Buffer;
    };
  }
}
