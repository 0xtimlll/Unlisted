export type Hex = string
export type BytesLike = Uint8Array | string | number | bigint
export declare function isHex(value: string): boolean
export declare function padify(hexOrBytes: string, opts?: { dir?: 'left' | 'right'; size?: number | null }): string
export declare function padify(hexOrBytes: Uint8Array, opts?: { dir?: 'left' | 'right'; size?: number | null }): Uint8Array
export declare function arrayify(value: BytesLike, size?: number): Uint8Array
export declare function hexlify(value: BytesLike): string
export declare class SizeExceedsPaddingSizeError extends Error {}
