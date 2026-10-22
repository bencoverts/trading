declare module 'cors' {
  import type { RequestHandler } from 'express';
  interface CorsOptions {
    origin?:
      | boolean
      | string
      | RegExp
      | Array<string | RegExp>
      | ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => void);
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
    optionsSuccessStatus?: number;
  }
  function cors(options?: CorsOptions): RequestHandler;
  export = cors;
}
