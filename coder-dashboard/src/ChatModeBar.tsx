/**
 * Bilah mode percakapan (Wave 11A, butir 42): "Diskusi" atau "Eksekusi".
 *
 * Mode disimpan di server per percakapan (`conversations.agent_mode`). Saat mode `diskusi`, server
 * menyisipkan instruksi tegas sebagai blok sistem paling awal, sehingga agen hanya menganalisis dan
 * tidak membuat atau mengubah berkas. Karena itu halaman induk perlu tahu mode aktif: ia mematikan
 * tombol yang mengubah data (padatkan percakapan, mode otonom, impor percakapan).
 */
import { useEffect, useState } from 'react';
import { api, failureOf, type AgentMode } from './api';

type Props = {
  conversationId: string | null;
  /** Dipanggil setiap mode aktif berubah, termasuk saat pertama kali dibaca dari server. */
  onMode?: (mode: AgentMode | '') => void;
  onError?: (message: string) => void;
};

export function ChatModeBar({ conversationId, onMode, onError }: Props) {
  const [mode, setMode] = useState<AgentMode | ''>('');
  const [bolehUbah, setBolehUbah] = useState(false);
  const [catatan, setCatatan] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  function fail(message: string): void {
    setProblem(message);
    onError?.(message);
  }

  useEffect(() => {
    let cancelled = false;
    if (!conversationId) {
      setMode('');
      setBolehUbah(false);
      setCatatan('');
      onMode?.('');
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        const data = await api.conversationMode(conversationId);
        if (cancelled) return;
        setMode(data.mode);
        setBolehUbah(Boolean(data.bolehUbah));
        setCatatan(String(data.catatan ?? ''));
        setProblem('');
        onMode?.(data.mode);
      } catch (error) {
        if (cancelled) return;
        setMode('');
        setCatatan('');
        fail(failureOf(error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  /** Menyimpan mode baru; UI hanya berubah setelah server membalas. */
  async function ubah(next: AgentMode): Promise<void> {
    if (!conversationId || busy) return;
    setBusy(true);
    setProblem('');
    try {
      const data = await api.saveConversationMode(conversationId, next);
      setMode(data.mode);
      setBolehUbah(Boolean(data.bolehUbah));
      setCatatan(String(data.catatan ?? ''));
      onMode?.(data.mode);
    } catch (error) {
      fail(failureOf(error).message);
    } finally {
      setBusy(false);
    }
  }

  const diskusi = mode === 'diskusi';
  const aktif = mode !== '';
  return (
    <div className={`mode-bar ${aktif ? (diskusi ? 'diskusi' : 'eksekusi') : ''}`} data-testid="chat-mode-bar" data-mode={mode || 'belum-dibaca'}>
      <b>Mode percakapan</b>
      <button
        type="button"
        className={diskusi ? 'mode-button active' : 'mode-button'}
        data-testid="chat-mode-diskusi"
        aria-pressed={diskusi}
        disabled={!conversationId || busy || !bolehUbah}
        title={bolehUbah ? 'Agen hanya menganalisis: tidak membuat atau mengubah berkas' : 'Peran viewer tidak boleh mengubah mode'}
        onClick={() => void ubah('diskusi')}
      >
        💬 Diskusi
      </button>
      <button
        type="button"
        className={mode === 'eksekusi' ? 'mode-button active' : 'mode-button'}
        data-testid="chat-mode-eksekusi"
        aria-pressed={mode === 'eksekusi'}
        disabled={!conversationId || busy || !bolehUbah}
        title={bolehUbah ? 'Agen boleh mengubah berkas dan menjalankan alat' : 'Peran viewer tidak boleh mengubah mode'}
        onClick={() => void ubah('eksekusi')}
      >
        ⚡ Eksekusi
      </button>
      {!conversationId && <p className="mode-note">Buka atau buat percakapan dulu untuk memilih mode.</p>}
      {conversationId && !aktif && !problem && <p className="mode-note">Mode belum terbaca dari server.</p>}
      {diskusi && (
        <p className="mode-note" data-testid="chat-mode-note">
          Bilah penanda: mode DISKUSI aktif. Agen hanya menganalisis, tidak membuat atau mengubah berkas sampai Anda
          memilih mode Eksekusi.{catatan ? ` ${catatan}` : ''}
        </p>
      )}
      {mode === 'eksekusi' && <p className="mode-note" data-testid="chat-mode-note">Mode EKSEKUSI: agen boleh mengubah berkas dan menjalankan alat.</p>}
      {problem && <p className="error">{problem}</p>}
    </div>
  );
}

export default ChatModeBar;
