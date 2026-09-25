/**
 * Port uji yang aman untuk `fetch()`.
 *
 * Sebab berkas ini ada (26 Sep 2026): beberapa suite memilih nomor port acak, dan sebagian nomor
 * dalam rentang itu DIBLOKIR oleh `fetch()` menurut daftar "bad port" pada spesifikasi Fetch. Bila
 * nomor terblokir yang terpilih, setiap `fetch()` langsung gagal dengan
 * `TypeError: fetch failed <- Error: bad port`, walaupun peladen uji hidup dan permintaan HTTP polos
 * (`node:http`) maupun sambungan TCP biasa berhasil. Gejalanya menyesatkan: suite melapor
 * "server tidak siap", sehingga gerbang rilis merah tanpa sebab yang tampak (dua kali terjadi:
 * gerbang penuh putaran 2 dan putaran 5, lalu direproduksi 2 dari 24 putaran mandiri).
 *
 * Daftar di bawah DIUKUR LANGSUNG, bukan dari ingatan: pada Node v22.23.2 di container ini, `fetch`
 * dipanggil ke setiap port 3300-7599 dan nomor yang gagal dengan pesan `bad port` dicatat
 * (skrip: /workspace/outputs/port_blokir2.mjs, 14 nomor).
 */
export const PORT_TERBLOKIR_FETCH: ReadonlySet<number> = new Set([
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
]);

/** Memilih satu nomor acak di rentang `[mulai, mulai + jumlah - 1]` yang TIDAK diblokir fetch. */
export function pilihPortUji(mulai: number, jumlah: number): number {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const kandidat = mulai + Math.floor(Math.random() * jumlah);
    if (!PORT_TERBLOKIR_FETCH.has(kandidat)) return kandidat;
  }
  throw new Error(`tidak menemukan port uji yang aman untuk fetch di rentang ${mulai}-${mulai + jumlah - 1}`);
}
