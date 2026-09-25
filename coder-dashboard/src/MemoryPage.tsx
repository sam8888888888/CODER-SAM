import { useState } from 'react';
import { MemoryBank } from './MemoryBank';
import { Learnings } from './Learnings';

/** Properti halaman Memori: pelapor galat dari App. */
type Props = { onError?: (message: string) => void };

/**
 * Halaman "Memori" dengan dua tab.
 *
 * Tab pertama tetap bank memori lama (tidak diubah perilakunya). Tab kedua adalah "Pelajaran"
 * (butir 60) yang datanya terpisah: bank memori menyimpan catatan gaya pengguna, pelajaran menyimpan
 * butir hasil pembelajaran agen. Keduanya disatukan di sini supaya pengguna menemukannya di satu
 * halaman, tanpa mengubah kode bank memori yang sudah dipakai halaman lain.
 */
export function MemoryPage({ onError }: Props) {
  const [tab, setTab] = useState<'bank' | 'pelajaran'>('bank');
  return (
    <div data-testid="memory-page" data-tab={tab}>
      <div className="tab-row" style={{ display: 'flex', gap: 8, margin: '16px 0', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="memory-tab-bank"
          className={tab === 'bank' ? 'primary' : ''}
          onClick={() => setTab('bank')}
        >
          Bank memori
        </button>
        <button
          type="button"
          data-testid="memory-tab-pelajaran"
          className={tab === 'pelajaran' ? 'primary' : ''}
          onClick={() => setTab('pelajaran')}
        >
          Pelajaran
        </button>
      </div>
      {tab === 'bank' ? <MemoryBank onError={onError} /> : <Learnings onError={onError} />}
    </div>
  );
}
