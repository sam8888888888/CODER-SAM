#!/usr/bin/env bash
# =============================================================================
# deploy/env-sync.sh — penyelaras kunci berkas .env (Wave 10, butir 32)
# =============================================================================
# Pakai:
#   deploy/env-sync.sh <berkas-env> [--check] [--keys-file <berkas>] [--backup-dir <dir>]
#
# Sifat:
#   - Menambahkan kunci yang BELUM ada di berkas .env tujuan; nilainya diambil dari baris
#     bawaan di berkas daftar kunci (bawaan: <direktori skrip>/env.keys.txt).
#   - NILAI KUNCI YANG SUDAH ADA TIDAK PERNAH DITIMPA.
#   - Baris `#usang KEY=nilai` di berkas daftar kunci TIDAK pernah ditambahkan. Kunci itu
#     hanya DILAPORKAN lewat `ENV_OBSOLETE_KEYS` bila masih ada di berkas .env tujuan.
#   - Kunci di berkas tujuan yang tidak ada di daftar resmi dilaporkan lewat
#     `ENV_UNKNOWN_KEYS` (tidak ditambahkan, tidak dihapus).
#   - `--check` = pratinjau: TIDAK menulis apa pun; isi dan mtime berkas tujuan tidak berubah.
#   - Cadangan bernomor `<berkas>.bak.1`, `.bak.2`, ... dibuat SEBELUM berkas diubah, dan
#     hanya bila memang ada kunci yang perlu ditambahkan. Cadangan lama tidak pernah ditimpa.
#   - Tidak pernah mencetak ISI nilai rahasia; hanya nama kunci dan nilai bawaan publik
#     yang memang tertulis di berkas daftar kunci.
#   - Idempoten: dijalankan dua kali tanpa perubahan -> ENV_ADDED 0, tanpa cadangan baru.
#   - Tanpa `eval`, tanpa `source` berkas env, tanpa `sed -i`.
#
# Baris keluaran yang bisa di-grep:
#   ENV_SYNC_MODE check|write        ENV_SYNC_ENV_FILE <path>     ENV_SYNC_KEYS_FILE <path>
#   ENV_MISSING <kunci>              (pratinjau: kunci yang belum ada di berkas tujuan)
#   ENV_MISSING_COUNT <jumlah>       (pratinjau)
#   ENV_ADD <kunci>                  (penulisan: kunci yang benar-benar ditambahkan)
#   ENV_ADDED <jumlah>
#   ENV_OBSOLETE_KEYS <k1,k2>        (tanpa kunci sama sekali bila tidak ada usang)
#   ENV_UNKNOWN_KEYS <k1,k2>         (tanpa kunci sama sekali bila tidak ada yang asing)
#   ENV_BACKUP <path>                (hanya bila cadangan benar-benar dibuat)
#   ENV_SYNC_CHECK_OK                (akhir pratinjau) / ENV_SYNC_OK (akhir penulisan)
#   ENV_SYNC_WARN <pesan>            (peringatan yang tidak menggagalkan proses)
#   ENV_SYNC_ERROR <pesan>           (gagal; keluar dengan kode 2)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEYS_FILE="${SCRIPT_DIR}/env.keys.txt"
ENV_FILE=""
CHECK=0
BACKUP_DIR=""

usage() {
  cat <<'USAGE'
pakai: deploy/env-sync.sh <berkas-env> [--check] [--keys-file <berkas>] [--backup-dir <dir>]

  <berkas-env>          berkas .env tujuan (harus sudah ada)
  --check               pratinjau; tidak menulis apa pun
  --keys-file <berkas>  daftar kunci resmi (bawaan: <direktori skrip>/env.keys.txt)
  --backup-dir <dir>    direktori cadangan (bawaan: direktori berkas .env)
  -h, --help            tampilkan bantuan ini
USAGE
}

while (( $# > 0 )); do
  case "${1}" in
    --check) CHECK=1; shift ;;
    --keys-file)
      (( $# >= 2 )) || { echo "ENV_SYNC_ERROR --keys-file butuh satu argumen" >&2; exit 2; }
      KEYS_FILE="${2}"; shift 2 ;;
    --backup-dir)
      (( $# >= 2 )) || { echo "ENV_SYNC_ERROR --backup-dir butuh satu argumen" >&2; exit 2; }
      BACKUP_DIR="${2}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "ENV_SYNC_ERROR argumen tidak dikenal: ${1}" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "${ENV_FILE}" ]]; then
        echo "ENV_SYNC_ERROR hanya satu berkas .env yang boleh diberikan" >&2
        usage >&2
        exit 2
      fi
      ENV_FILE="${1}"; shift ;;
  esac
done

if [[ -z "${ENV_FILE}" ]]; then
  echo "ENV_SYNC_ERROR berkas .env tujuan belum diberikan" >&2
  usage >&2
  exit 2
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ENV_SYNC_ERROR berkas tujuan tidak ada: ${ENV_FILE}" >&2
  exit 2
fi
if [[ ! -f "${KEYS_FILE}" ]]; then
  echo "ENV_SYNC_ERROR berkas daftar kunci tidak ada: ${KEYS_FILE}" >&2
  exit 2
fi

# --------------------------------------------------------------- baca daftar kunci resmi
ADD_KEYS=()      # nama kunci resmi, urut sesuai berkas
ADD_LINES=()     # baris utuh "KEY=nilai" untuk kunci resmi
OBS_KEYS=()      # nama kunci usang
declare -A ADD_SEEN=()
declare -A OBS_SEEN=()

line_no=0
while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
  line_no=$(( line_no + 1 ))
  line="${raw_line%$'\r'}"
  trimmed="${line#"${line%%[![:space:]]*}"}"
  [[ -z "${trimmed}" ]] && continue
  if [[ "${trimmed}" =~ ^\#[[:space:]]*usang[[:space:]]+([A-Z_][A-Z0-9_]*)= ]]; then
    key="${BASH_REMATCH[1]}"
    if [[ -n "${OBS_SEEN[${key}]:-}" ]]; then
      echo "ENV_SYNC_WARN baris usang ganda diabaikan (baris ${line_no}): ${key}"
      continue
    fi
    OBS_SEEN["${key}"]=1
    OBS_KEYS+=("${key}")
    continue
  fi
  if [[ "${trimmed}" == \#* ]]; then
    continue
  fi
  if [[ "${trimmed}" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    key="${BASH_REMATCH[1]}"
    if [[ -n "${ADD_SEEN[${key}]:-}" ]]; then
      echo "ENV_SYNC_WARN kunci ganda di daftar resmi diabaikan (baris ${line_no}): ${key}"
      continue
    fi
    ADD_SEEN["${key}"]=1
    ADD_KEYS+=("${key}")
    ADD_LINES+=("${trimmed}")
    continue
  fi
  echo "ENV_SYNC_WARN baris ${line_no} di daftar kunci dilewati (bukan komentar, bukan KEY=nilai)"
done < "${KEYS_FILE}"

for key in "${ADD_KEYS[@]+"${ADD_KEYS[@]}"}"; do
  if [[ -n "${OBS_SEEN[${key}]:-}" ]]; then
    echo "ENV_SYNC_WARN kunci ${key} ada di daftar resmi sekaligus daftar usang; diperlakukan usang (tidak ditambahkan)"
  fi
done

# --------------------------------------------------------------- baca kunci di berkas tujuan
declare -A TARGET_SEEN=()
TARGET_KEYS=()
while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
  line="${raw_line%$'\r'}"
  if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)= ]]; then
    key="${BASH_REMATCH[2]}"
    if [[ -z "${TARGET_SEEN[${key}]:-}" ]]; then
      TARGET_SEEN["${key}"]=1
      TARGET_KEYS+=("${key}")
    fi
  fi
done < "${ENV_FILE}"

# --------------------------------------------------------------- hitung selisih
MISSING_KEYS=()
MISSING_LINES=()
ADDED_KEYS=()
OBS_PRESENT=()
UNKNOWN_KEYS=()

# ${!arr[@]} tidak boleh dibungkus ${...+...}, jadi jumlahnya diperiksa lebih dulu.
if (( ${#ADD_KEYS[@]} > 0 )); then
  for i in "${!ADD_KEYS[@]}"; do
    key="${ADD_KEYS[${i}]}"
    [[ -n "${OBS_SEEN[${key}]:-}" ]] && continue
    if [[ -z "${TARGET_SEEN[${key}]:-}" ]]; then
      MISSING_KEYS+=("${key}")
      MISSING_LINES+=("${ADD_LINES[${i}]}")
    fi
  done
fi

for key in "${OBS_KEYS[@]+"${OBS_KEYS[@]}"}"; do
  [[ -n "${TARGET_SEEN[${key}]:-}" ]] && OBS_PRESENT+=("${key}")
done

for key in "${TARGET_KEYS[@]+"${TARGET_KEYS[@]}"}"; do
  [[ -n "${ADD_SEEN[${key}]:-}" ]] && continue
  [[ -n "${OBS_SEEN[${key}]:-}" ]] && continue
  UNKNOWN_KEYS+=("${key}")
done

join_comma() {
  local out="" item
  for item in "$@"; do
    if [[ -z "${out}" ]]; then out="${item}"; else out="${out},${item}"; fi
  done
  printf '%s' "${out}"
}

# --------------------------------------------------------------- tulis (hanya tanpa --check)
BACKUP_PATH=""
if (( CHECK == 0 )) && (( ${#MISSING_KEYS[@]} > 0 )); then
  target_dir="$(cd "$(dirname "${ENV_FILE}")" && pwd)"
  dest_dir="${BACKUP_DIR:-${target_dir}}"
  if [[ ! -d "${dest_dir}" ]]; then
    mkdir -p "${dest_dir}"
  fi
  base="$(basename "${ENV_FILE}")"
  n=1
  while [[ -e "${dest_dir}/${base}.bak.${n}" ]]; do
    n=$(( n + 1 ))
  done
  BACKUP_PATH="${dest_dir}/${base}.bak.${n}"
  cp -p "${ENV_FILE}" "${BACKUP_PATH}"
fi

if (( CHECK == 0 )) && (( ${#MISSING_KEYS[@]} > 0 )); then
  # Berkas yang baris terakhirnya belum berakhir dengan newline diberi newline dulu,
  # supaya kunci pertama yang ditambahkan tidak menempel di baris terakhir.
  if [[ -s "${ENV_FILE}" && -n "$(tail -c 1 "${ENV_FILE}")" ]]; then
    printf '\n' >> "${ENV_FILE}"
  fi
  for i in "${!MISSING_KEYS[@]}"; do
    printf '%s\n' "${MISSING_LINES[${i}]}" >> "${ENV_FILE}"
    ADDED_KEYS+=("${MISSING_KEYS[${i}]}")
  done
fi

# --------------------------------------------------------------- laporan
if (( CHECK == 1 )); then
  printf 'ENV_SYNC_MODE check\n'
else
  printf 'ENV_SYNC_MODE write\n'
fi
printf 'ENV_SYNC_ENV_FILE %s\n' "${ENV_FILE}"
printf 'ENV_SYNC_KEYS_FILE %s\n' "${KEYS_FILE}"

if (( CHECK == 1 )); then
  for key in "${MISSING_KEYS[@]+"${MISSING_KEYS[@]}"}"; do
    printf 'ENV_MISSING %s\n' "${key}"
  done
  printf 'ENV_MISSING_COUNT %s\n' "${#MISSING_KEYS[@]}"
else
  for key in "${ADDED_KEYS[@]+"${ADDED_KEYS[@]}"}"; do
    printf 'ENV_ADD %s\n' "${key}"
  done
fi
printf 'ENV_ADDED %s\n' "${#ADDED_KEYS[@]}"

if [[ -n "${BACKUP_PATH}" ]]; then
  printf 'ENV_BACKUP %s\n' "${BACKUP_PATH}"
fi

if (( ${#OBS_PRESENT[@]} > 0 )); then
  printf 'ENV_OBSOLETE_KEYS %s\n' "$(join_comma "${OBS_PRESENT[@]}")"
else
  printf 'ENV_OBSOLETE_KEYS\n'
fi

if (( ${#UNKNOWN_KEYS[@]} > 0 )); then
  printf 'ENV_UNKNOWN_KEYS %s\n' "$(join_comma "${UNKNOWN_KEYS[@]}")"
else
  printf 'ENV_UNKNOWN_KEYS\n'
fi

if (( CHECK == 1 )); then
  printf 'ENV_SYNC_CHECK_OK\n'
else
  printf 'ENV_SYNC_OK\n'
fi
