/**
 * CommandPalette — modal command palette for the dashboard (Ctrl+K / Cmd+K).
 * Shows a searchable list of commands, filters on label + keywords,
 * supports keyboard navigation (ArrowUp/ArrowDown wrap, Enter runs, Escape closes)
 * and mouse selection. All user-facing text is Indonesian.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export type PaletteItem = { key: string; label: string; hint?: string; keywords?: string };

const DIALOG_LABEL = 'Palet perintah';
const SEARCH_LABEL = 'Cari perintah';
const SEARCH_PLACEHOLDER = 'Cari perintah...';
const EMPTY_MESSAGE = 'Tidak ada perintah yang cocok';
const FOOTER_HINT = 'Enter untuk menjalankan, Esc untuk menutup';

// Huruf kecil tanpa spasi tepi, supaya pencarian tidak peka huruf besar/kecil.
function normalize(text: string): string {
  return text.trim().toLowerCase();
}

// Peringkat: 0 = label mulai dengan kata kunci, 1 = cocok di bagian lain. Angka kecil tampil lebih dulu.
function matchRank(item: PaletteItem, query: string): number {
  if (query.length === 0) return 0;
  return normalize(item.label).startsWith(query) ? 0 : 1;
}

function matches(item: PaletteItem, query: string): boolean {
  if (query.length === 0) return true;
  const label = normalize(item.label);
  const keywords = normalize(item.keywords ?? '');
  return label.includes(query) || keywords.includes(query);
}

export function CommandPalette({
  items,
  onSelect,
  onClose,
}: {
  items: PaletteItem[];
  onSelect: (key: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Fokus otomatis ke kolom pencarian saat palet dibuka.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Hasil pencarian: cocokkan label + keywords, lalu urutkan yang mulai dengan kata kunci.
  const results = useMemo<PaletteItem[]>(() => {
    const needle = normalize(query);
    return items
      .map((item, index) => ({ item, index }))
      .filter(entry => matches(entry.item, needle))
      .sort((a, b) => {
        const rankDiff = matchRank(a.item, needle) - matchRank(b.item, needle);
        return rankDiff !== 0 ? rankDiff : a.index - b.index;
      })
      .map(entry => entry.item);
  }, [items, query]);

  // Sorotan dijaga tetap valid walau daftar hasil berubah.
  const active = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1);

  // Kolom pencarian baru diisi lagi -> sorotan kembali ke hasil teratas.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Geser daftar agar item aktif selalu terlihat.
  useEffect(() => {
    if (active < 0) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((active + 1) % results.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((active - 1 + results.length) % results.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results[active];
      if (chosen) onSelect(chosen.key);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={event => {
        // Klik latar (bukan panel) menutup palet.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={DIALOG_LABEL}
        className="mt-24 w-full max-w-xl mx-auto overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
          <span aria-hidden="true" className="text-slate-400">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={SEARCH_LABEL}
            placeholder={SEARCH_PLACEHOLDER}
            className="w-full bg-transparent px-1 py-1 text-sm text-slate-200 placeholder-slate-500 outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup palet perintah"
            className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700/60"
          >
            Esc
          </button>
        </div>

        <div ref={listRef} role="listbox" aria-label="Daftar perintah" className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">{EMPTY_MESSAGE}</p>
          ) : (
            results.map((item, index) => {
              const isActive = index === active;
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : 'false'}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => onSelect(item.key)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                    isActive ? 'bg-slate-700/60 text-slate-100' : 'text-slate-200 hover:bg-slate-700/40'
                  }`}
                >
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.hint ? <span className="shrink-0 text-xs text-slate-400">{item.hint}</span> : null}
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-slate-700 px-3 py-2 text-xs text-slate-400">{FOOTER_HINT}</div>
      </div>
    </div>
  );
}
