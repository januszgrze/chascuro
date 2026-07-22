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

  const QRCode: {
    toDataURL(value: string, options?: ToDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
