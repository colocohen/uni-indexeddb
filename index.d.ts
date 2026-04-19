declare function createDB(opts?: {
    /** Server only. Directory for LevelDB files. Default: './data' */
    dir?: string;
}): createDB.DB;

declare namespace createDB {
    interface ScanOptions {
        /** Key to start after */
        after?: string | null;
        /** Max records per chunk. 0 or omitted = byte-based chunking (~64KB) */
        limit?: number;
    }

    interface ImportWriter {
        write(chunk: Uint8Array): void;
        end(): void;
    }

    interface DB {
        put(table: string, data: [key: string | number, value: Uint8Array | null][], cb: (err: any, count?: number) => void): void;
        get(table: string, keys: (string | number)[], cb: (err: any, rows?: Record<string, Uint8Array | null>) => void): void;

        scan(table: string, cursor: string | null, cb: (err: any, rows?: [string, Uint8Array][], cursor?: string | null, done?: boolean) => void): void;
        scan(table: string, cursor: ScanOptions, cb: (err: any, rows?: [string, Uint8Array][], cursor?: string | null, done?: boolean) => void): void;

        count(table: string, cb: (err: any, count?: number) => void): void;
        stat(table: string, cb: (err: any, info?: { count: number; size: number; status: string }) => void): void;
        tables(cb: (err: any, tables?: string[]) => void): void;
        drop(table: string, cb: (err: any) => void): void;

        export(table: string, cb: (err: any, chunk?: Uint8Array, done?: boolean) => void): void;

        import(table: string, buf: Uint8Array, cb: (err: any, count?: number) => void): void;
        import(table: string, buf: Uint8Array, opts: { replace?: boolean }, cb: (err: any, count?: number) => void): void;
        import(table: string, cb: (err: any, count?: number) => void): ImportWriter;
        import(table: string, opts: { replace?: boolean }, cb: (err: any, count?: number) => void): ImportWriter;

        close(cb: (err: any) => void): void;
    }
}

export = createDB;
