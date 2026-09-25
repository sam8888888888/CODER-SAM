import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, type ConnectorKind, type ConnectorTestResponse, type ConnectorView, type ConnectorsResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, TABEL, SEL, angka, waktu } from './w11b';

type Props = { onError?: (message: string) => void };

/**
 * Halaman "Konektor" (butir 71).
 *
 * Aturan yang menentukan bentuk halaman ini: STATUS DI LAYAR HARUS SAMA DENGAN KENYATAAN SERVER.
 *  - Daftar konektor selalu dibaca ulang dari server setelah setiap tindakan.
 *  - `lastError` ditampilkan apa adanya (kode + pesan dari proses pengiriman), tanpa diterjemahkan.
 *  - Status 'aktif' hanya muncul kalau hulu benar-benar menjawab 2xx; satu-satunya cara membuktikannya
 *    adalah tombol "Uji" yang menjalankan pengiriman nyata.
 *  - Rahasia tidak pernah ditampilkan: hanya host, penanda terpasang, dan empat karakter terakhir.
 */
export function Connectors({ onError }: Props) {
  const [data, setData] = useState<ConnectorsResponse | null>(null);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState(false);

  const [jenis, setJenis] = useState<ConnectorKind>('slack');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [nama, setNama] = useState('');
  const [alat, setAlat] = useState('');
  const [hasilUji, setHasilUji] = useState<Record<string, ConnectorTestResponse>>({});

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muat = useCallback(async () => {
    try {
      const jawaban = await api.connectors();
      setData(jawaban);
      setGalat('');
    } catch (error) {
      const detail = failureOf(error);
      gagal(`Gagal memuat konektor: ${detail.message || detail.code}`);
    }
  }, [gagal]);

  useEffect(() => { void muat(); }, [muat]);

  const daftar: ConnectorView[] = data?.konektor ?? [];

  /** Tambah konektor. Jenis MCP hanya boleh memakai alat yang diizinkan admin platform. */
  async function tambah(): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.createConnector({
        kind: jenis,
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(nama.trim() ? { nama: nama.trim() } : {}),
        ...(alat.trim() ? { alat: alat.split(',').map((item) => item.trim()).filter(Boolean) } : {}),
      });
      setPesan(jawaban.pesan);
      setToken('');
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /** Jalankan uji kirim. Jawaban server disimpan per id supaya bisa dibandingkan dengan status di tabel. */
  async function uji(konektorId: string): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.testConnector(konektorId);
      setHasilUji((lama) => ({ ...lama, [konektorId]: jawaban }));
      setPesan(jawaban.hasil?.pesan || jawaban.pekerjaan.pesan);
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      const extra = (detail.body ?? {}) as Partial<ConnectorTestResponse>;
      if (extra.konektor) setHasilUji((lama) => ({ ...lama, [konektorId]: extra as ConnectorTestResponse }));
      gagal(`${detail.message || detail.code} [${detail.code}]`);
      await muat();
    } finally {
      setSibuk(false);
    }
  }

  async function ubahStatus(konektor: ConnectorView): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.updateConnector(konektor.id, { enabled: !konektor.enabled });
      setPesan(jawaban.pesan);
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
      await muat();
    } finally {
      setSibuk(false);
    }
  }

  async function hapus(konektorId: string): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      await api.deleteConnector(konektorId);
      setHasilUji((lama) => { const salinan = { ...lama }; delete salinan[konektorId]; return salinan; });
      setPesan('Konektor dihapus di server.');
      await muat();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
      await muat();
    } finally {
      setSibuk(false);
    }
  }

  return (
    <section className="space-y-3 text-sm text-slate-200" data-testid="connectors"
      data-jumlah={daftar.length} data-kunci={data?.pengaturan.kunci ?? ''}
      data-mcp-terbuka={data?.pengaturan.mcpTerbuka ? 'true' : 'false'}>
      <header className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-100">🔌 Konektor</h2>
        <p className="text-xs text-slate-400">
          Sambungan keluar ke Slack, Discord, atau server MCP. Hanya alamat yang host-nya ada di daftar putih
          platform yang boleh dipakai. Status di tabel ini selalu sama dengan status yang tersimpan di server.
        </p>
      </header>

      {galat ? <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300" data-testid="connectors-galat">{galat}</p> : null}
      {pesan ? <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-300" data-testid="connectors-pesan">{pesan}</p> : null}

      <div className={`${CARD} space-y-2`} data-testid="connector-katalog-kartu">
        <b className="text-slate-100">Katalog platform</b>
        <table className={TABEL} data-testid="connector-katalog">
          <thead>
            <tr>
              <th className={SEL} scope="col">Jenis</th>
              <th className={SEL} scope="col">Nama</th>
              <th className={SEL} scope="col">Status platform</th>
              <th className={SEL} scope="col">Rahasia</th>
              <th className={SEL} scope="col">Keterangan</th>
            </tr>
          </thead>
          <tbody>
            {(data?.katalog ?? []).map((baris) => (
              <tr key={baris.kind} data-testid={`connector-katalog-${baris.kind}`} data-status={baris.status}>
                <td className={SEL}>{baris.kind}</td>
                <td className={SEL}>{baris.nama}</td>
                <td className={SEL}>{baris.status}</td>
                <td className={SEL}>{baris.rahasia}</td>
                <td className={SEL}>{baris.keterangan}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data ? (
          <p className="text-xs text-slate-400" data-testid="connector-pengaturan">
            Daftar putih host: {data.pengaturan.daftarPutihHost.join(', ') || '(kosong)'} · alat MCP diizinkan:{' '}
            {data.pengaturan.mcpAllowedTools.join(', ') || '(belum ada)'} · batas hulu {angka(data.pengaturan.batasMenungguHuluMs)} ms ·
            batas hidup proses anak {angka(data.pengaturan.batasHidupProsesAnakMs)} ms · maksimal {angka(data.pengaturan.maksimalKonektor)} konektor.
            <br />{data.catatan}
          </p>
        ) : null}
      </div>

      <div className={`${CARD} space-y-2`} data-testid="connector-tambah-kartu">
        <b className="text-slate-100">Tambah konektor</b>
        <div className="flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            Jenis
            <select className={`${FIELD} w-32`} data-testid="connector-jenis" value={jenis}
              onChange={(event) => setJenis(event.target.value as ConnectorKind)}>
              {(data?.pengaturan.jenisKonektor ?? ['slack', 'discord', 'mcp']).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className={LABEL}>
            Alamat webhook
            <input className={`${FIELD} w-80`} data-testid="connector-url" value={url} placeholder="https://…"
              onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className={LABEL}>
            Nama (opsional)
            <input className={`${FIELD} w-40`} data-testid="connector-nama" value={nama} onChange={(event) => setNama(event.target.value)} />
          </label>
          <label className={LABEL}>
            Token (opsional, tidak ditampilkan kembali)
            <input type="password" autoComplete="off" className={`${FIELD} w-56`} data-testid="connector-token" value={token}
              onChange={(event) => setToken(event.target.value)} />
          </label>
          <label className={LABEL}>
            Alat MCP (pisah koma)
            <input className={`${FIELD} w-56`} data-testid="connector-alat" value={alat} onChange={(event) => setAlat(event.target.value)} />
          </label>
          <button type="button" className={BTN_UTAMA} data-testid="connector-tambah" disabled={sibuk} onClick={() => { void tambah(); }}>
            {sibuk ? 'Menyimpan…' : 'Tambah'}
          </button>
        </div>
      </div>

      <div className={`${CARD} space-y-2`} data-testid="connector-daftar-kartu">
        <b className="text-slate-100">Sambungan saya ({angka(daftar.length)})</b>
        {daftar.length === 0 ? (
          <p className="text-xs text-slate-400">Belum ada konektor. Tambahkan satu di atas, lalu tekan Uji.</p>
        ) : daftar.map((konektor) => {
          const jawaban = hasilUji[konektor.id];
          return (
            <div key={konektor.id} className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-2 text-xs"
              data-testid={`connector-${konektor.id}`}
              data-status={konektor.status}
              data-enabled={konektor.enabled ? 'true' : 'false'}
              data-host={konektor.tautan.host ?? ''}>
              <p>
                <b>{konektor.kind}</b> · {konektor.nama || '(tanpa nama)'} · {konektor.enabled ? 'aktif diizinkan' : 'nonaktif'} ·
                status server: <span data-testid={`connector-status-${konektor.id}`}
                  className={konektor.status === 'aktif' ? 'text-emerald-300' : konektor.status === 'gagal' ? 'text-rose-300' : 'text-amber-300'}>
                  {konektor.status}
                </span>
              </p>
              <p>
                Host: {konektor.tautan.host ?? '—'} · alamat: {konektor.tautan.ekor || '—'} ·
                rahasia: {konektor.tautan.terpasang ? 'terpasang' : 'belum ada'} ·
                alat: {konektor.tautan.alat.join(', ') || '—'} · diperbarui {waktu(konektor.updatedAt)}
              </p>
              <p data-testid={`connector-lasterror-${konektor.id}`} className={konektor.lastError ? 'text-rose-300' : 'text-slate-400'}>
                Galat terakhir dari server: {konektor.lastError || '(kosong — belum ada kegagalan)'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={BTN_UTAMA} data-testid={`connector-uji-${konektor.id}`} disabled={sibuk} onClick={() => { void uji(konektor.id); }}>
                  Uji
                </button>
                <button type="button" className={BTN} data-testid={`connector-toggle-${konektor.id}`} disabled={sibuk} onClick={() => { void ubahStatus(konektor); }}>
                  {konektor.enabled ? 'Matikan' : 'Aktifkan'}
                </button>
                <button type="button" className={BTN} data-testid={`connector-hapus-${konektor.id}`} disabled={sibuk} onClick={() => { void hapus(konektor.id); }}>
                  Hapus
                </button>
              </div>
              {jawaban?.hasil ? (
                <div className="rounded-lg border border-slate-700 px-2 py-1"
                  data-testid={`connector-hasil-${konektor.id}`}
                  data-kode={jawaban.hasil.kode}
                  data-status={jawaban.hasil.status}
                  data-hulu={String(jawaban.hasil.upstreamStatus ?? '')}>
                  <p>Hasil uji: <b>{jawaban.hasil.status}</b> · kode {jawaban.hasil.kode} · hulu HTTP {String(jawaban.hasil.upstreamStatus ?? '—')} · {angka(jawaban.hasil.durasiMs)} ms</p>
                  <p data-testid={`connector-hasil-pesan-${konektor.id}`}>{jawaban.hasil.pesan}</p>
                  <p>Pekerjaan: {jawaban.pekerjaan.diklaim} ({jawaban.pekerjaan.id ?? 'tanpa id'}) — {jawaban.pekerjaan.pesan}</p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default Connectors;
