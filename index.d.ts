declare function createDB(opts?: {
    /** Server only. Directory for LevelDB files. Default: './data' */
    dir?: string;
    /** Browser only. Prefix for IndexedDB database names. Default: '' */
    prefix?: string;
}): createDB.DB;

declare namespace createDB {
    interface DB {
        put(table: string, data: [key: string | number, value: Uint8Array | null][], cb: (err: any, count?: number) => void): void;
        get(table: string, keys: (string | number)[], cb: (err: any, rows?: Record<string, Uint8Array | null>) => void): void;
        scan(table: string, cursor: string | null, cb: (err: any, rows?: [string, Uint8Array][], cursor?: string | null, done?: boolean) => void): void;
        stat(table: string, cb: (err: any, info?: { count: number; size: number; status: string }) => void): void;
        close(cb: (err: any) => void): void;
    }
}

export = createDB;
