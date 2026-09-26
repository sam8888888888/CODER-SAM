import { useCallback, useEffect, useState } from 'react';
import { api, failureOf, type BotChannel, type BotLinkCode, type BotTestResponse } from './api';
import { BTN, BTN_UTAMA, CARD, FIELD, LABEL, TABEL, SEL, angka, waktu } from './w11b';

type Props = { isAdmin?: boolean; onError?: (message: string) => void };

/**
 * Hasil satu "uji kirim". Cabang `ok: true` HANYA dipakai saat server menjawab 2xx, yaitu saat hulu
 * Telegram benar-benar menerima pesan; kegagalan hulu (502) selalu mendarat di cabang `ok: false`
 * dengan teks jawaban Telegram apa adanya.
 */
type HasilUji =
  | { ok: true; jawaban: BotTestResponse }
  | { ok: false; kode: string; pesan: string; status: number; pesanHulu: string };

/**
 * Halaman "Kanal bot" (butir 69 + 81).
 *
 * Dua bagian dalam satu halaman:
 *  1. Admin platform: kanal Telegram/WhatsApp (nama, nama agen, tagline, aktif, token tersegel).
 *  2. Pengguna: kode pemasangan akun ke bot dan daftar tautan yang sudah dipasang.
 *
 * Dua tindakan NYATA (bukan pura-pura), dan keduanya menampilkan jawaban hulu APA ADANYA:
 *  1. SIMPAN: saat kanal Telegram disimpan dengan token dan alamat publik terisi, server benar-benar
 *     memanggil `setWebhook` ke Telegram.
 *  2. UJI KIRIM (butir 69, v0.23.1): tombol per kanal memanggil
 *     `POST /api/v1/admin/bot-channels/:id/test`; server benar-benar mengirim SATU pesan uji lewat kanal
 *     yang tersimpan, memakai pemanggil yang sama dengan balasan sungguhan.
 * Kalau Telegram menolak, layar menampilkan penolakan itu dan tidak pernah menulis "berhasil".
 */
export function BotChannels({ isAdmin = false, onError }: Props) {
  const [channels, setChannels] = useState<BotChannel[]>([]);
  const [galat, setGalat] = useState('');
  const [pesan, setPesan] = useState('');
  const [sibuk, setSibuk] = useState(false);

  // Isian admin
  const [id, setId] = useState('');
  const [provider, setProvider] = useState<'telegram' | 'whatsapp'>('telegram');
  const [nama, setNama] = useState('Bot Telegram COBLAI');
  const [token, setToken] = useState('');
  const [agen, setAgen] = useState('Dinda');
  const [tagline, setTagline] = useState('Asisten COBLAI');
  const [enabled, setEnabled] = useState(true);
  const [hasilSimpan, setHasilSimpan] = useState<BotChannel | null>(null);
  // Tujuan uji kirim: kosong = server memakai tautan paling baru di kanal itu.
  const [chatIdUji, setChatIdUji] = useState('');
  const [hasilUji, setHasilUji] = useState<Record<string, HasilUji>>({});

  // Bagian pengguna
  const [kode, setKode] = useState<BotLinkCode | null>(null);
  const [tautan, setTautan] = useState<Array<{ id: string; channelId: string; provider: string; kanal: string; externalId: string; linkedAt: string }>>([]);

  const gagal = useCallback((message: string) => { setGalat(message); onError?.(message); }, [onError]);

  const muatKanal = useCallback(async () => {
    if (!isAdmin) { setChannels([]); return; }
    try {
      const jawaban = await api.botChannels();
      setChannels(jawaban.channels ?? []);
    } catch (error) {
      const detail = failureOf(error);
      gagal(`Gagal memuat kanal bot: ${detail.message || detail.code}`);
    }
  }, [gagal, isAdmin]);

  const muatTautan = useCallback(async () => {
    try {
      const jawaban = await api.botIdentities();
      setTautan(jawaban.identitas ?? []);
    } catch (error) {
      const detail = failureOf(error);
      gagal(`Gagal memuat tautan bot: ${detail.message || detail.code}`);
    }
  }, [gagal]);

  useEffect(() => { void muatKanal(); void muatTautan(); }, [muatKanal, muatTautan]);

  /** Simpan kanal. `pasangWebhook: true` = server benar-benar mendaftarkan webhook Telegram. */
  async function simpanKanal(): Promise<void> {
    if (!isAdmin) { gagal('Hanya admin platform yang boleh mengubah kanal bot.'); return; }
    if (!id && !token.trim()) { gagal('Token bot wajib diisi saat membuat kanal baru.'); return; }
    setSibuk(true); setGalat(''); setPesan(''); setHasilSimpan(null);
    try {
      const jawaban = await api.saveBotChannel({
        ...(id ? { id } : {}),
        provider,
        name: nama,
        ...(token.trim() ? { token: token.trim() } : {}),
        agentName: agen,
        tagline,
        enabled,
        pasangWebhook: true,
      });
      setHasilSimpan(jawaban.channel);
      setId(jawaban.channel.id);
      setToken('');
      setPesan('Kanal tersimpan di server. Hasil pendaftaran webhook ada di bawah, apa adanya dari hulu.');
      await muatKanal();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /**
   * Uji kirim (butir 69). Hasilnya disimpan per kanal supaya bisa dibandingkan dengan tabel di atas,
   * dan pesan galat server (kode + `detail.pesanHulu`) ditampilkan apa adanya — termasuk saat hulu
   * Telegram menolak pesan uji.
   */
  async function ujiKanal(kanalId: string): Promise<void> {
    if (!isAdmin) { gagal('Hanya admin platform yang boleh mengirim pesan uji.'); return; }
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.botTestChannel(kanalId, chatIdUji.trim() ? { chatId: chatIdUji.trim() } : {});
      setHasilUji((lama) => ({ ...lama, [kanalId]: { ok: true, jawaban } }));
      setPesan(`Pesan uji terkirim ke ${jawaban.tujuan} lewat ${jawaban.jalur} (hulu HTTP ${jawaban.statusHulu.join(', ') || '—'}).`);
    } catch (error) {
      const detail = failureOf(error);
      const badan = (detail.body ?? {}) as { detail?: { pesanHulu?: unknown } };
      setHasilUji((lama) => ({
        ...lama,
        [kanalId]: {
          ok: false, kode: detail.code, pesan: detail.message, status: detail.status,
          pesanHulu: String(badan.detail?.pesanHulu ?? ''),
        },
      }));
      gagal(`Uji kirim gagal: ${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /** Buat kode pemasangan sekali pakai untuk akun ini. */
  async function buatKode(): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.botLinkCode();
      setKode(jawaban.kode);
      setPesan('Kode pemasangan dibuat. Kirim perintah di bawah dari akun bot Anda sebelum kedaluwarsa.');
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  /** Cabut tautan. Keadaan berikutnya selalu dibaca ulang dari server, bukan dari tebakan halaman. */
  async function cabut(tautanId: string): Promise<void> {
    setSibuk(true); setGalat(''); setPesan('');
    try {
      const jawaban = await api.botRevokeIdentity(tautanId);
      setPesan(`Tautan ${jawaban.id} dicabut oleh ${jawaban.oleh}.`);
      await muatTautan();
    } catch (error) {
      const detail = failureOf(error);
      gagal(`${detail.message || detail.code} [${detail.code}]`);
    } finally {
      setSibuk(false);
    }
  }

  async function salin(teks: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(teks);
      setPesan('Alamat webhook disalin ke papan klip.');
    } catch {
      setPesan('Peramban menolak papan klip. Salin alamatnya manual dari layar.');
    }
  }

  const kategori = (jenis: string) => {
    const warna = jenis === 'aktif' ? 'text-emerald-300' : jenis === 'gagal' ? 'text-rose-300' : 'text-amber-300';
    return `${warna} font-medium`;
  };

  return (
    <section className="space-y-3 text-sm text-slate-200" data-testid="bot-channels" data-jumlah={channels.length}>
      <header className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-100">🤖 Kanal bot</h2>
        <p className="text-xs text-slate-400">
          Satu bot per kanal: Telegram atau WhatsApp. Token disegel di server dan hanya penanda terpasang +
          empat karakter terakhir yang dikembalikan API. Pengguna memasang akunnya ke bot memakai kode
          pemasangan sekali pakai.
        </p>
      </header>

      <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="bot-catatan-honest">
        Dua tindakan nyata di halaman ini. <b>Simpan</b>: kalau kanal Telegram disimpan dengan token dan
        alamat publik platform terisi, server langsung memanggil <code> setWebhook </code> ke Telegram.
        <b>Uji kirim</b>: server benar-benar mengirim SATU pesan uji lewat kanal tersimpan
        (<code>POST /api/v1/admin/bot-channels/:id/test</code>, batas 3 percobaan / 10 menit per kanal).
        Keduanya memuat jawaban hulu apa adanya — penolakan Telegram ditampilkan sebagai penolakan,
        bukan sebagai keberhasilan.
      </p>

      {galat ? <p role="alert" className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-300" data-testid="bot-galat">{galat}</p> : null}
      {pesan ? <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-300" data-testid="bot-pesan">{pesan}</p> : null}

      {isAdmin ? (
        <div className={`${CARD} space-y-2`} data-testid="bot-admin">
          <b className="text-slate-100">Bagian admin platform</b>
          <div className="flex flex-wrap items-end gap-2">
            <label className={LABEL}>
              Penyedia
              <select className={`${FIELD} w-40`} data-testid="bot-provider" value={provider}
                onChange={(event) => setProvider(event.target.value as 'telegram' | 'whatsapp')}>
                <option value="telegram">telegram</option>
                <option value="whatsapp">whatsapp</option>
              </select>
            </label>
            <label className={LABEL}>
              Nama kanal
              <input className={`${FIELD} w-52`} data-testid="bot-nama" value={nama} onChange={(event) => setNama(event.target.value)} />
            </label>
            <label className={LABEL}>
              Nama agen
              <input className={`${FIELD} w-36`} data-testid="bot-agen" value={agen} onChange={(event) => setAgen(event.target.value)} />
            </label>
            <label className={LABEL}>
              Tagline
              <input className={`${FIELD} w-52`} data-testid="bot-tagline" value={tagline} onChange={(event) => setTagline(event.target.value)} />
            </label>
            <label className={LABEL}>
              Token bot (tidak ditampilkan kembali)
              <input type="password" autoComplete="off" className={`${FIELD} w-56`} data-testid="bot-token" value={token}
                placeholder={id ? '(biarkan kosong untuk mempertahankan token lama)' : '123456:ABC…'}
                onChange={(event) => setToken(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" data-testid="bot-enabled" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> aktif
            </label>
            <label className={LABEL}>
              Tujuan uji kirim (chat id, opsional)
              <input className={`${FIELD} w-48`} data-testid="bot-chat-uji" value={chatIdUji}
                placeholder="kosong = tautan terbaru di kanal" onChange={(event) => setChatIdUji(event.target.value)} />
            </label>
            <button type="button" className={BTN_UTAMA} data-testid="bot-simpan" disabled={sibuk} onClick={() => { void simpanKanal(); }}>
              {sibuk ? 'Menyimpan…' : 'Simpan & daftarkan webhook'}
            </button>
            <button type="button" className={BTN} data-testid="bot-baru" disabled={sibuk}
              onClick={() => { setId(''); setToken(''); setHasilSimpan(null); setPesan('Isian direset: penyimpanan berikutnya membuat kanal baru.'); }}>
              Isian baru
            </button>
          </div>

          {hasilSimpan ? (
            <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-2 text-xs"
              data-testid="bot-hasil"
              data-terdaftar={hasilSimpan.webhook.terdaftar ? 'true' : 'false'}
              data-status={String(hasilSimpan.webhook.status ?? '')}
              data-url={hasilSimpan.webhook.url ?? ''}>
              <p>Kanal <b>{hasilSimpan.name}</b> ({hasilSimpan.provider}) tersimpan dengan id {hasilSimpan.id}.</p>
              <p>Rahasia: {hasilSimpan.rahasia.terpasang ? `terpasang, ekor ${hasilSimpan.rahasia.ekor}` : 'belum ada'} · tersegel: belum dibuka ulang oleh halaman ini.</p>
              <p data-testid="bot-webhook-terdaftar" className={kategori(hasilSimpan.webhook.terdaftar ? 'aktif' : 'gagal')}>
                Pendaftaran webhook ke hulu: {hasilSimpan.webhook.terdaftar ? 'terdaftar' : 'TIDAK terdaftar'}
                {hasilSimpan.webhook.status === undefined ? '' : ` (HTTP ${hasilSimpan.webhook.status})`}
              </p>
              <p data-testid="bot-pesan-hulu">Jawaban hulu apa adanya: {hasilSimpan.webhook.pesan ?? '(tidak ada pesan)'}</p>
              {hasilSimpan.webhook.url ? (
                <p className="flex flex-wrap items-center gap-2">
                  <span>Alamat webhook platform:</span>
                  <code className="break-all text-slate-300" data-testid="bot-webhook-url">{hasilSimpan.webhook.url}</code>
                  <button type="button" className={BTN} data-testid="bot-salin" onClick={() => { void salin(String(hasilSimpan.webhook.url)); }}>Salin</button>
                </p>
              ) : (
                <p className="text-amber-300" data-testid="bot-webhook-url">Alamat publik platform belum diisi, jadi webhook belum punya alamat.</p>
              )}
            </div>
          ) : null}

          <table className={TABEL} data-testid="bot-daftar">
            <thead>
              <tr>
                <th className={SEL} scope="col">Kanal</th>
                <th className={SEL} scope="col">Penyedia</th>
                <th className={SEL} scope="col">Aktif</th>
                <th className={SEL} scope="col">Token</th>
                <th className={SEL} scope="col">Alamat webhook</th>
                <th className={SEL} scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {channels.length === 0 ? (
                <tr><td className={SEL} colSpan={6}>Belum ada kanal bot di server.</td></tr>
              ) : channels.map((kanal) => (
                <tr key={kanal.id} data-testid={`bot-kanal-${kanal.id}`} data-enabled={kanal.enabled ? 'true' : 'false'}
                  data-terdaftar={kanal.webhook.terdaftar ? 'true' : 'false'}>
                  <td className={SEL}>{kanal.name}</td>
                  <td className={SEL}>{kanal.provider}</td>
                  <td className={SEL}>{kanal.enabled ? 'ya' : 'tidak'}</td>
                  <td className={SEL}>{kanal.rahasia.terpasang ? `terpasang · ekor ${kanal.rahasia.ekor}` : 'belum ada'}</td>
                  <td className={SEL}>{kanal.webhook.url ?? '—'}</td>
                  <td className={SEL}>
                    <button type="button" className={BTN} data-testid={`bot-ubah-${kanal.id}`}
                      onClick={() => {
                        setId(kanal.id); setProvider(kanal.provider); setNama(kanal.name);
                        setAgen(kanal.agentName); setTagline(kanal.tagline); setEnabled(kanal.enabled);
                        setToken(''); setHasilSimpan(kanal);
                        setPesan('Isian dimuat dari server. Kosongkan token kalau tidak ingin menggantinya.');
                      }}>
                      Muat ke isian
                    </button>
                    <button type="button" className={`${BTN} ml-1`} data-testid={`bot-uji-${kanal.id}`} disabled={sibuk}
                      onClick={() => { void ujiKanal(kanal.id); }}>
                      Uji kirim
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Hasil uji kirim per kanal, apa adanya dari server. Blok ini hanya muncul SESUDAH admin
              menekan tombol, jadi layar tidak pernah mengarang hasil. */}
          {Object.keys(hasilUji).length ? (
            <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-2 text-xs" data-testid="bot-uji-daftar">
              <b className="text-slate-100">Hasil uji kirim</b>
              {Object.entries(hasilUji).map(([kanalId, hasil]) => (
                <div key={kanalId} className="rounded-lg border border-slate-700 px-2 py-1"
                  data-testid={`bot-uji-hasil-${kanalId}`}
                  data-terkirim={hasil.ok && hasil.jawaban.terkirim ? 'true' : 'false'}
                  data-kode={hasil.ok ? '' : hasil.kode}
                  data-status={hasil.ok ? hasil.jawaban.statusHulu.join(',') : String(hasil.status)}>
                  {hasil.ok ? (
                    <>
                      <p data-testid={`bot-uji-ringkas-${kanalId}`} className={kategori('aktif')}>
                        Terkirim: ya · kanal {kanalId} · tujuan {hasil.jawaban.tujuan} · jalur {hasil.jawaban.jalur} · hulu HTTP {hasil.jawaban.statusHulu.join(', ') || '—'} · {angka(hasil.jawaban.panjangTeks)} karakter
                      </p>
                      <p data-testid={`bot-uji-hulu-${kanalId}`}>Jawaban hulu apa adanya: {hasil.jawaban.pesanHulu || '(hulu tidak mengirim pesan)'}</p>
                    </>
                  ) : (
                    <>
                      <p data-testid={`bot-uji-ringkas-${kanalId}`} className={kategori('gagal')}>
                        TIDAK terkirim · kanal {kanalId} · {hasil.kode} (HTTP {hasil.status})
                      </p>
                      <p data-testid={`bot-uji-galat-${kanalId}`}>{hasil.pesan}</p>
                      <p data-testid={`bot-uji-hulu-${kanalId}`}>Jawaban hulu apa adanya: {hasil.pesanHulu || '(tidak ada teks hulu pada galat ini)'}</p>
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-400" data-testid="bot-admin-tertutup">
          Pengaturan kanal bot hanya untuk admin platform. Bagian pemasangan akun di bawah tetap bisa Anda pakai.
        </p>
      )}

      <div className={`${CARD} space-y-2`} data-testid="bot-identitas">
        <b className="text-slate-100">Pemasangan akun Anda ke bot</b>
        <p className="text-xs text-slate-400">
          Tekan tombol untuk membuat kode sekali pakai, lalu kirim perintahnya dari akun bot Anda. Satu akun
          hanya boleh punya satu tautan aktif per kanal.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className={BTN_UTAMA} data-testid="bot-identitas-tombol" disabled={sibuk} onClick={() => { void buatKode(); }}>
            {sibuk ? 'Memproses…' : 'Buat kode pemasangan'}
          </button>
          {/* Daftar tautan dibaca ulang dari server supaya pemasangan dari luar kanal (mis. skrip)
              ikut terlihat tanpa memuat ulang seluruh halaman. */}
          <button type="button" className={BTN} data-testid="bot-identitas-muat" disabled={sibuk}
            onClick={() => { void muatTautan(); }}>
            Muat ulang tautan
          </button>
        </div>
        {kode ? (
          <div className="space-y-1 rounded-lg border border-slate-700 bg-slate-900/60 px-2 py-2 text-xs"
            data-testid="bot-kode" data-kode={kode.kode} data-kanal={kode.kanal} data-perintah={kode.perintah}>
            <p>Kode: <b className="text-lg tracking-widest text-slate-100">{kode.kode}</b> (kanal {kode.kanal} · {kode.provider})</p>
            <p data-testid="bot-kode-perintah">Kirim: <code>{kode.perintah}</code></p>
            <p data-testid="bot-kode-kedaluwarsa">Berlaku {angka(kode.berlakuMenit)} menit, kedaluwarsa {waktu(kode.kedaluwarsa)} · maksimal {angka(kode.maksPercobaan)} percobaan.</p>
            <p>{kode.caraPakai}</p>
          </div>
        ) : null}
        <table className={TABEL} data-testid="bot-identitas-daftar">
          <thead>
            <tr>
              <th className={SEL} scope="col">Kanal</th>
              <th className={SEL} scope="col">Id luar</th>
              <th className={SEL} scope="col">Dipasang</th>
              <th className={SEL} scope="col">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {tautan.length === 0 ? (
              <tr><td className={SEL} colSpan={4}>Belum ada tautan bot untuk akun ini.</td></tr>
            ) : tautan.map((baris) => (
              <tr key={baris.id} data-testid={`bot-identitas-${baris.id}`} data-provider={baris.provider}>
                <td className={SEL}>{baris.kanal}</td>
                <td className={SEL}>{baris.externalId}</td>
                <td className={SEL}>{waktu(baris.linkedAt)}</td>
                <td className={SEL}>
                  <button type="button" className={BTN} data-testid={`bot-cabut-${baris.id}`} disabled={sibuk} onClick={() => { void cabut(baris.id); }}>
                    Cabut
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default BotChannels;
