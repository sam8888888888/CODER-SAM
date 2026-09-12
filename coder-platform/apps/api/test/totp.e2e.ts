import { base32Encode, hotp, totp, verifyTotp } from "../src/totp.js";
let failures = 0;
function check(name: string, ok: boolean, detail = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`); if (!ok) failures += 1; }
// RFC 4226 appendix D vectors (secret "12345678901234567890").
const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
check("base32 of the RFC secret", secret === "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", secret);
check("hotp counter 0", hotp(secret, 0, 6) === "755224", hotp(secret, 0, 6));
check("hotp counter 1", hotp(secret, 1, 6) === "287082", hotp(secret, 1, 6));
check("hotp counter 2", hotp(secret, 2, 6) === "359152", hotp(secret, 2, 6));
// RFC 6238 appendix B vectors (8 digits).
check("totp at 59s", totp(secret, { digits: 8, at: 59_000 }) === "94287082", totp(secret, { digits: 8, at: 59_000 }));
check("totp at 1111111109s", totp(secret, { digits: 8, at: 1_111_111_109_000 }) === "07081804", totp(secret, { digits: 8, at: 1_111_111_109_000 }));
check("totp at 1234567890s", totp(secret, { digits: 8, at: 1_234_567_890_000 }) === "89005924", totp(secret, { digits: 8, at: 1_234_567_890_000 }));
const current = totp(secret, { at: 1_234_567_890_000 });
check("verify accepts the current code", verifyTotp(secret, current, { at: 1_234_567_890_000 }));
check("verify accepts the previous step", verifyTotp(secret, totp(secret, { at: 1_234_567_860_000 }), { at: 1_234_567_890_000 }));
check("verify rejects a wrong code", !verifyTotp(secret, "000000", { at: 1_234_567_890_000 }));
check("verify rejects a non numeric code", !verifyTotp(secret, "abcdef", { at: 1_234_567_890_000 }));
check("verify rejects a far away step", !verifyTotp(secret, totp(secret, { at: 1_234_560_000_000 }), { at: 1_234_567_890_000 }));
console.log(failures === 0 ? "ALL_TOTP_TESTS_PASSED" : `TOTP_FAILURES=${failures}`);
process.exit(failures === 0 ? 0 : 1);
