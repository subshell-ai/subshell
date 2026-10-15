declare module "bcrypt-pbkdf" {
  /** Derive OpenSSH's AES key and counter; returns zero on success. */
  export function pbkdf(
    pass: Uint8Array,
    passLength: number,
    salt: Uint8Array,
    saltLength: number,
    output: Uint8Array,
    outputLength: number,
    rounds: number,
  ): number;
}
