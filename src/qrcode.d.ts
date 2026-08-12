declare module 'qrcode' {
  interface ToDataUrlOptions {
    readonly errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    readonly margin?: number;
    readonly width?: number;
    readonly color?: {
      readonly dark?: string;
      readonly light?: string;
    };
  }

  interface ToStringOptions extends ToDataUrlOptions {
    readonly type: 'svg';
  }

  const QRCode: {
    toDataURL(value: string, options?: ToDataUrlOptions): Promise<string>;
    toString(value: string, options: ToStringOptions): Promise<string>;
  };

  export default QRCode;
}
