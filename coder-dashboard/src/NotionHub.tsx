import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, type NotionIntegration, type NotionPage, type NotionResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, TABEL, SEL, angka, pesanGalat, waktu } from './w11b';

type Props = { onError?: (message: string) => void };

/**
 * Halaman "Notion" (butir 68).
 *
 * Aturan yang menentukan bentuk halaman ini:
 *  - Token Notion hanya DIKIRIM. Server tidak pernah mengembalikannya, jadi halaman ini tidak pernah
 *    menyimpannya di state dan tidak pernah menampilkannya kembali. Setelah simpan berhasil, isian
 *    token dikosongkan supaya teks token juga tidak tertinggal di DOM.
 *  - Kalau server menolak, kalimat Indonesia dan kode mesin dari server ditampilkan APA ADANYA
 *    (`NOTION_TOKEN_INVALID`, `NOTION_NOT_CONNECTED`, `NOTION_UPSTREAM_ERROR`, `SECRETS_KEY_MISSING`,
 *    `NOTION_PAGE_RATE_LIMITED`, ...). Halaman tidak pernah menyusun pesan keberhasilannya sendiri.
 *  - Riwayat halaman datang dari server (`integration.halaman`), bukan dari state halaman ini, supaya
 *    yang terlihat sama dengan yang tersimpan.
 */
export function NotionHub({ onError }: Props) {
  const [data, setData] = useState<NotionResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState(false);

  const [token, setToken] = useState('');
  const [judul, setJudul] = useState('Catatan dari COBLAI');
  const [isi, setIsi] = useState('');
  const [halamanBaru, setHalamanBaru] = useState<NotionPage | null>(null);

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muat = useCallback(async () => {
    try {
      const jawaban = await api.notion();
      setData(jawaban);
      setGalat('');
    } catch (error) {
      const detail = failureOf(error);
      gagal(`Gagal memuat keadaan sambungan Notion: ${detail.message || detail.code}`);
    }
  }, [gagal]);

  useEffect(() => { void muat(); }, [muat]);

  const integrasi: NotionIntegration | null = data?.integration ?? null;

  /** Simpan token. Server memverifikasi ke Notion lebih dulu; gagal berarti tidak ada yang disimpan. */
  async function simpanToken(): Promise<void> {
    const nilai = token.trim();
    if (!nilai) { gagal('Isi token Notion lebih dulu (token dari halaman integrasi Notion Anda).'); return; }
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.notionConnect(nilai);
      setToken('');
      setPesan(`${jawaban.pesan}${jawaban.workspace?.name ? ` Ruang kerja: ${jawaban.workspace.name}.` : ''}`);
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /** Putuskan sambungan: server menghapus barisnya, jadi keadaan berikutnya dibaca ulang dari server. */
  async function putuskan(): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      await api.notionDisconnect();
      setPesan('Sambungan Notion diputus dan token tersegel ikut dihapus server.');
      setHalamanBaru(null);
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /** Buat halaman baru di Notion. URL yang tampil adalah URL dari jawaban Notion (server meneruskan). */
  async function kirimHalaman(): Promise<void> {
    const judulBersih = judul.trim();
    if (!judulBersih) { gagal('Judul halaman belum diisi.'); return; }
    setSibuk(true); setGalat(''); setPesan(''); setHalamanBaru(null);
    try {
      const jawaban = await api.notionCreatePage({ title: judulBersih, content: isi });
      setHalamanBaru(jawaban.halaman);
      setData((lama) => (lama ? { ...lama, integration: jawaban.integration } : lama));
      setPesan('Halaman dibuat di Notion. Tautan di bawah ini berasal dari jawaban Notion, bukan rakitan halaman.');
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  const terpasang = Boolean(integrasi?.terpasang);
  const kunciSiap = data?.kunci === 'ok';

  return (
    <section className="space-y-3 text-sm text-slate-200" data-testid="notion-hub"
      data-terpasang={terpasang ? 'true' : 'false'}
      data-kunci={data?.kunci ?? ''}
      data-jumlah={integrasi?.jumlahHalaman ?? 0}>
      <header className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-100">🗂️ Notion</h2>
        <p className="text-xs text-slate-400">
          Sambungkan satu ruang kerja Notion, lalu kirim jawaban agen menjadi halaman. Token disimpan tersegel
          di server dan tidak pernah ditampilkan kembali — halaman ini hanya menampilkan penanda terpasang dan
          empat karakter terakhirnya.
        </p>
      </header>

      {galat ? <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300" data-testid="notion-galat">{galat}</p> : null}
      {pesan ? <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-300" data-testid="notion-pesan">{pesan}</p> : null}

      <div className={`${CARD} space-y-2`} data-testid="notion-sambungan">
        <b className="text-slate-100">Sambungan</b>
        {terpasang ? (
          <ul className="space-y-1 text-xs text-slate-300">
            <li>Status: <span className="text-emerald-300" data-testid="notion-status">terpasang</span></li>
            <li>Token: <span data-testid="notion-ekor">{integrasi?.ekor || '(tanpa ekor)'}</span> · tersegel: {integrasi?.tersegel ? 'ya' : 'tidak'} · bisa dibuka server: {integrasi?.bisaDibuka ? 'ya' : 'tidak'}</li>
            <li>Ruang kerja: <span data-testid="notion-workspace">{integrasi?.workspace?.name || '(tanpa nama)'}</span></li>
            <li>Tersambung sejak: <span data-testid="notion-sejak">{waktu(integrasi?.connectedAt)}</span></li>
          </ul>
        ) : (
          <p className="text-xs text-slate-300" data-testid="notion-status">belum tersambung</p>
        )}

        {!kunciSiap ? (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200" data-testid="notion-kunci-peringatan">
            Penyimpanan rahasia platform belum siap (status kunci: {data?.kunci || 'tidak diketahui'}). Selama
            itu token tidak bisa disimpan dan server menjawab 503 SECRETS_KEY_MISSING.
          </p>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            Token integrasi Notion
            <input
              type="password"
              autoComplete="off"
              className={`${FIELD} w-72`}
              data-testid="notion-token"
              value={token}
              disabled={sibuk}
              placeholder="secret_… atau ntn_…"
              onChange={(event) => { setToken(event.target.value); setGalat(''); }}
            />
          </label>
          <button type="button" className={BTN_UTAMA} data-testid="notion-simpan" disabled={sibuk} onClick={() => { void simpanToken(); }}>
            {sibuk ? 'Menyimpan…' : 'Simpan & uji token'}
          </button>
          <button type="button" className={BTN} data-testid="notion-putus" disabled={sibuk || !terpasang} onClick={() => { void putuskan(); }}>
            Putuskan
          </button>
        </div>
        {data ? (
          <p className="text-xs text-slate-400" data-testid="notion-batas">
            Batas: maksimal {angka(data.batas.pembuatanHalaman)} halaman per {angka(data.batas.jendelaMenit)} menit ·
            riwayat {angka(data.batas.halamanDisimpan)} halaman terakhir · judul maks {angka(data.batas.judulMaks)} karakter ·
            isi maks {angka(data.batas.isiMaks)} karakter.
          </p>
        ) : null}
      </div>

      <div className={`${CARD} space-y-2`} data-testid="notion-kirim-kartu">
        <b className="text-slate-100">Kirim halaman ke Notion</b>
        <div className="flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            Judul halaman
            <input
              className={`${FIELD} w-72`}
              data-testid="notion-judul"
              value={judul}
              disabled={sibuk}
              onChange={(event) => setJudul(event.target.value)}
            />
          </label>
          <button type="button" className={BTN_UTAMA} data-testid="notion-kirim" disabled={sibuk} onClick={() => { void kirimHalaman(); }}>
            {sibuk ? 'Mengirim…' : 'Kirim ke Notion'}
          </button>
        </div>
        <label className={LABEL}>
          Isi halaman (dipisah baris kosong menjadi paragraf)
          <textarea
            className={`${FIELD} h-28 w-full`}
            data-testid="notion-isi"
            value={isi}
            disabled={sibuk}
            onChange={(event) => setIsi(event.target.value)}
          />
        </label>
        {halamanBaru ? (
          <div className="space-y-1 text-xs" data-testid="notion-hasil" data-url={halamanBaru.url}>
            <p className="text-emerald-300">
              Halaman tersimpan di riwayat server dengan id {halamanBaru.id || '(tanpa id)'}.
            </p>
            {halamanBaru.url ? (
              <a className="text-violet-300 underline" data-testid="notion-url" href={halamanBaru.url} target="_blank" rel="noreferrer">
                {halamanBaru.url}
              </a>
            ) : (
              <p className="text-amber-300" data-testid="notion-url">Notion tidak mengirim tautan halaman untuk permintaan ini.</p>
            )}
          </div>
        ) : null}
      </div>

      <div className={`${CARD} space-y-2`} data-testid="notion-riwayat">
        <b className="text-slate-100">Riwayat halaman ({angka(integrasi?.jumlahHalaman ?? 0)})</b>
        {(integrasi?.halaman?.length ?? 0) === 0 ? (
          <p className="text-xs text-slate-400">Belum ada halaman yang dibuat dari akun ini.</p>
        ) : (
          <table className={TABEL}>
            <thead>
              <tr>
                <th className={SEL} scope="col">Judul</th>
                <th className={SEL} scope="col">Dibuat</th>
                <th className={SEL} scope="col">Tautan</th>
              </tr>
            </thead>
            <tbody>
              {integrasi?.halaman.map((halaman) => (
                <tr key={halaman.id || halaman.url} data-testid={`notion-halaman-${halaman.id}`}>
                  <td className={SEL}>{halaman.title}</td>
                  <td className={SEL}>{waktu(halaman.createdAt)}</td>
                  <td className={SEL}>
                    {halaman.url ? (
                      <a className="text-violet-300 underline" href={halaman.url} target="_blank" rel="noreferrer">buka</a>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-slate-400">{data?.catatan ?? ''}</p>
      </div>
    </section>
  );
}

export default NotionHub;
