import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface AndreDriveUser {
  id: string;
  name: string;
  email: string;
}

export interface AndreDriveCategory {
  id: string;
  name: string;
  icon: string;
  builtin: boolean;
}

export interface AndreDriveFolder {
  id: string;
  name: string;
  parent: string | null;
  color: 'green' | 'purple' | 'orange' | 'blue';
  count?: number;
}

export interface AndreDriveFileMetadata {
  title?: string;
  original_title?: string;
  year?: string;
  plot?: string;
  genres?: string;
  group_title?: string;
  runtime_minutes?: string | number;
  rating?: string | number;
  cast?: string;
  director?: string;
  country?: string;
  language?: string;
  tmdb_id?: string;
  imdb_id?: string;
  tvg_id?: string;
  poster_url?: string;
  poster_source?: 'url' | 'upload';
  episode_title?: string;
  episode_image_url?: string;
  author?: string;
  narrator?: string;
  source?: string;
}

export interface AndreDriveFile {
  id: string;
  name: string;
  image?: string;
  duration?: string;
  quality?: string;
  size: number;
  kind: string;
  category_name?: string;
  mime: string;
  created: string;
  deleted?: string;
  starred: boolean;
  folder: string | null;
  series?: string;
  season?: number;
  episode?: number;
  hls?: 'ready' | 'pending' | 'failed';
  scene?: number;
  demo?: boolean;
  cloud_source?: string;
  metadata?: AndreDriveFileMetadata;
}

export interface AndreDriveShareLink {
  token: string;
  type: 'file' | 'folder' | 'collection' | 'playlist';
  target: string;
  created: string;
}

export interface AndreDriveUploadSession {
  id: string;
  name: string;
  mime: string;
  size: number;
  folder: string | null;
  kind: string;
  series: string;
  season: number;
  episode: number;
  chunkBytes: number;
  parts: number[];
  chunks: Map<number, Buffer>;
  completed: boolean;
  file?: AndreDriveFile;
}

export interface DeviceAccount {
  id: string;
  label: string;
  username: string;
  password?: string;
  can_write?: boolean;
  created: string;
  last_used?: string | null;
}

export interface JellyfinSessionRecord {
  token: string;
  accountId: string;
  userId: string;
  username: string;
  deviceId: string;
  client: string;
  deviceName: string;
  version: string;
  created: string;
}

export interface JellyfinItemUserState {
  played: boolean;
  playCount: number;
  positionTicks: number;
  favorite: boolean;
  lastPlayed?: string;
}

export interface CloudConnection {
  id: string;
  provider: 'onedrive' | 'google-drive' | 'torbox';
  label: string;
  canMove: boolean;
  created: string;
}

export interface CloudTransferJob {
  id: string;
  connectionId: string;
  name: string;
  size: number;
  copied: number;
  verified: number;
  status: 'copying' | 'verifying' | 'source_pending' | 'done' | 'kept' | 'cancelled';
  operation: 'copy' | 'move';
  folder: string | null;
  kind: string;
  series?: string;
  fileId?: string;
  error?: string;
}

export interface PersistedAccountSnapshot {
  user: AndreDriveUser;
  folders: AndreDriveFolder[];
  files: AndreDriveFile[];
  trashedFiles: AndreDriveFile[];
  customCategories: AndreDriveCategory[];
  links: AndreDriveShareLink[];
  fileBuffersBase64: Record<string, string>;
  jellyfinAccounts: DeviceAccount[];
  jellyfinSessions?: Record<string, JellyfinSessionRecord>;
  jellyfinUserState?: Record<string, JellyfinItemUserState>;
  navidromeAccounts: DeviceAccount[];
  opdsAccounts: DeviceAccount[];
  audiobookshelfAccounts: DeviceAccount[];
  webdavAccounts: DeviceAccount[];
  rommSettings: { server_url: string; folder_id: string; username?: string; password?: string };
  tmdbSettings: { configured: boolean; personal: boolean; token?: string };
  cloudConnections: CloudConnection[];
  cloudTransfers: CloudTransferJob[];
}

interface PersistedDiskStore {
  activeUserId: string;
  isLoggedIn: boolean;
  accounts: Record<string, PersistedAccountSnapshot>;
}

export const BUILTIN_CATEGORIES: AndreDriveCategory[] = [
  { id: 'movie', name: 'Filme', icon: 'film', builtin: true },
  { id: 'series', name: 'Serien', icon: 'tv', builtin: true },
  { id: 'music', name: 'Musik', icon: 'music', builtin: true },
  { id: 'audiobook', name: 'Hörbücher', icon: 'headphones', builtin: true },
  { id: 'podcast', name: 'Podcasts', icon: 'podcast', builtin: true },
  { id: 'book', name: 'Bücher', icon: 'book', builtin: true },
  { id: 'game', name: 'Spiele', icon: 'gamepad', builtin: true },
  { id: 'comic', name: 'Comics & Mangas', icon: 'comic', builtin: true },
  { id: 'photo', name: 'Fotos & Bilder', icon: 'image', builtin: true },
  { id: 'document', name: 'Dokumente', icon: 'file', builtin: true },
  { id: 'software', name: 'Software', icon: 'code', builtin: true },
  { id: 'other', name: 'Sonstiges', icon: 'folder', builtin: true },
];

export const INITIAL_FOLDERS: AndreDriveFolder[] = [
  { id: 'd1', name: 'Filme', parent: null, color: 'green' },
  { id: 'd2', name: 'Serien', parent: null, color: 'purple' },
  { id: 'd3', name: 'Reisen & Erinnerungen', parent: null, color: 'orange' },
  { id: 'd4', name: 'Projekte', parent: null, color: 'blue' },
];

export const REMOVED_PLACEHOLDER_IDS = new Set<string>([
  'file-alpine-escape',
  'file-ocean-between-us',
  'file-into-the-wild-s01e01',
  'file-tokyo-after-hours',
  'file-art-of-slowing-down',
  'file-somewhere-in-the-forest',
  'file-tausend-meilen-staub-s01e01',
  'file-tausend-meilen-staub-s01e02',
  'file-tausend-meilen-staub-s01e03',
  'demo0',
  'demo1',
  'demo2',
  'demo3',
  'demo4',
  'demo5',
  'demo6',
  'demo7',
  'demo8',
]);

export function isPlaceholderFileId(id: string | undefined | null): boolean {
  if (!id) return false;
  return REMOVED_PLACEHOLDER_IDS.has(id) || /^demo\d+$/i.test(id);
}

const RAWHIDE_POSTER_PROXY =
  '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F18%2F46291.jpg';

const RAWHIDE_S1_EPISODES: Record<
  number,
  { title: string; plot: string; image: string; defaultDuration: string }
> = {
  1: {
    title: 'Fluch des Goldes (Incident of the Tumbleweed)',
    plot: 'Trailboss Gil Favor und sein Stellvertreter Rowdy Yates (Clint Eastwood) begegnen zu Beginn des Rindertrecks einer Gefangenentransport-Kutsche, deren Insassen den gesamten Treck in Gefahr bringen.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F135%2F339979.jpg',
    defaultDuration: '49:11',
  },
  2: {
    title: 'Unruhe in Alamosa (Incident at Alabaster Plain)',
    plot: 'Auf dem Weg durch die Hochebene von Alabaster geraten Gil Favor und Rowdy Yates in einen gefährlichen Konflikt rund um ein altes Kloster und verfolgte Gesetzlose.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F136%2F341971.jpg',
    defaultDuration: '48:55',
  },
  3: {
    title: 'Schatten der Vergangenheit (Incident with an Executioner)',
    plot: 'Während der Rindertreck durch staubiges Grenzland zieht, schließt sich ein geheimnisvoller Fremder der Mannschaft um Gil Favor und Rowdy Yates an.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F137%2F343879.jpg',
    defaultDuration: '49:10',
  },
  4: {
    title: 'Am Rande des Abgrunds (Incident of the Widowed Dove)',
    plot: 'Gil Favor und Rowdy Yates nehmen eine Witwe unter ihren Schutz, die auf der Flucht vor skrupellosen Verfolgern Zuflucht beim Rindertreck sucht.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F138%2F345912.jpg',
    defaultDuration: '48:29',
  },
  5: {
    title: 'An der Grenze der Macht (Incident on the Edge of Madness)',
    plot: 'Ein ehemaliger Südstaaten-Offizier versucht, die Männer des Trecks für einen waghalsigen Plan an der Grenze zu gewinnen.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F139%2F347515.jpg',
    defaultDuration: '48:37',
  },
  6: {
    title: 'Macht und Pflug (Incident of the Power and the Plow)',
    plot: 'Der Rindertreck gerät in einen erbitterten Streit zwischen Siedlern und Weidelandbesitzern.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F141%2F352868.jpg',
    defaultDuration: '49:00',
  },
  7: {
    title: 'Zwischenfall in Barker Springs (Incident at Barker Springs)',
    plot: 'In Barker Springs wird die Mannschaft des Trecks mit einem gefährlichen Hinterhalt konfrontiert.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F141%2F354587.jpg',
    defaultDuration: '49:00',
  },
  8: {
    title: 'Westlich von Lano (Incident West of Lano)',
    plot: 'Westlich von Lano müssen Gil Favor und Rowdy Yates die Herde durch schweres Unwetter und feindliches Gebiet führen.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F142%2F356286.jpg',
    defaultDuration: '49:00',
  },
  9: {
    title: 'Stadt in Angst (Incident of the Town in Terror)',
    plot: 'Eine verängstigte Grenzstadt verweigert dem Treck den Durchzug, bis Gil Favor dem Geheimnis der Bewohner auf den Grund geht.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F143%2F358155.jpg',
    defaultDuration: '49:00',
  },
  10: {
    title: 'Das goldene Kalb (Incident of the Golden Calf)',
    plot: 'Die Aussicht auf schnelles Gold stellt den Zusammenhalt der Cowboys auf eine harte Probe.',
    image:
      '/api/tmdb/image?url=https%3A%2F%2Fstatic.tvmaze.com%2Fuploads%2Fimages%2Foriginal_untouched%2F144%2F360824.jpg',
    defaultDuration: '49:00',
  },
};

export function upgradeRealUploadedFiles(files: AndreDriveFile[]): AndreDriveFile[] {
  const result: AndreDriveFile[] = [];
  for (const rawFile of files) {
    if (!rawFile || !rawFile.id || isPlaceholderFileId(rawFile.id) || rawFile.demo) {
      continue;
    }
    const f = structuredClone(rawFile);
    if (/tausend\s+meilen\s+staub|rawhide/i.test(f.name)) {
      const seMatch = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(f.name);
      const season = seMatch ? Number(seMatch[1]) : Number(f.season) || 1;
      const episode = seMatch ? Number(seMatch[2]) : Number(f.episode) || 1;
      const epInfo = season === 1 ? RAWHIDE_S1_EPISODES[episode] : undefined;
      f.kind = 'series';
      f.series = 'Tausend Meilen Staub';
      f.season = season;
      f.episode = episode;
      if (!f.duration || f.duration === '03:15') {
        f.duration = epInfo?.defaultDuration || '49:00';
      }
      const curMeta = f.metadata || {};
      const wasMisidentified =
        !curMeta.title ||
        curMeta.title === 'One in a Million' ||
        curMeta.original_title === 'One in a Million' ||
        !curMeta.poster_url ||
        curMeta.poster_url === '/images/alpine-escape.jpg';

      if (wasMisidentified) {
        f.metadata = {
          ...curMeta,
          title: 'Tausend Meilen Staub',
          original_title: 'Rawhide',
          year: '1959',
          plot:
            epInfo?.plot ||
            'Trailboss Gil Favor (Eric Fleming) und sein junger Stellvertreter Rowdy Yates (Clint Eastwood) treiben in den 1860er-Jahren eine riesige Rinderherde von San Antonio im Süden von Texas über tausend Meilen bis nach Sedalia in Missouri.',
          genres: 'Western, Abenteuer, Drama, Serie',
          runtime_minutes: '49',
          rating: '8.3',
          director: 'Charles Marquis Warren',
          cast: 'Eric Fleming, Clint Eastwood, Paul Brinegar, Sheb Wooley, Steve Raines, James Murdock',
          country: 'USA',
          language: 'Deutsch / Englisch',
          tmdb_id: '10952',
          imdb_id: 'tt0052504',
          poster_url: RAWHIDE_POSTER_PROXY,
          poster_source: 'url',
          episode_title: epInfo?.title || curMeta.episode_title || `Episode ${episode}`,
          episode_image_url: epInfo?.image || RAWHIDE_POSTER_PROXY,
        };
      }
      if (!f.image || f.image === '/images/alpine-escape.jpg') {
        f.image = f.metadata?.episode_image_url || f.metadata?.poster_url || RAWHIDE_POSTER_PROXY;
      }
    }
    result.push(f);
  }
  return result;
}

export const INITIAL_FILES: AndreDriveFile[] = [];

export const DEFAULT_CLOUD_CONNECTIONS: CloudConnection[] = [
  {
    id: 'conn-torbox-1',
    provider: 'torbox',
    label: 'TorBox Cloud Seedbox',
    canMove: true,
    created: '2026-11-01T12:00:00Z',
  },
  {
    id: 'conn-gdrive-1',
    provider: 'google-drive',
    label: 'Google Drive (LPAndreU97@gmail.com)',
    canMove: false,
    created: '2026-11-01T14:00:00Z',
  },
];

export function generateShareToken(): string {
  return crypto.randomBytes(32).toString('hex'); // Exactly 64 hex chars for Xtream 32+32 split
}

export function inferCategoryFromMimeAndName(mime: string, name: string, requestedKind?: string): string {
  if (requestedKind && requestedKind !== 'auto') return requestedKind;
  const lower = name.toLowerCase();
  if (/s\d{1,2}e\d{1,2}/i.test(name)) return 'series';
  if (mime.startsWith('video/') || /\.(mp4|mkv|mov|webm|avi)$/i.test(lower)) return 'movie';
  if (/\.(m4b)$/i.test(lower)) return 'audiobook';
  if (mime.startsWith('audio/') || /\.(mp3|flac|wav|ogg|m4a)$/i.test(lower)) return 'music';
  if (/\.(epub|pdf|mobi|azw3)$/i.test(lower)) return 'book';
  if (/\.(cbz|cbr)$/i.test(lower)) return 'comic';
  if (/\.(nes|sfc|smc|gba|gbc|gb|n64|z64|iso|rom|nds|wbfs|rvz|chd)$/i.test(lower)) return 'game';
  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|svg|avif)$/i.test(lower)) return 'photo';
  if (/\.(zip|tar|gz|7z|dmg|exe|deb|rpm|appimage)$/i.test(lower)) return 'software';
  if (/\.(txt|md|doc|docx|xls|xlsx|ppt|pptx|csv|json|yaml|yml)$/i.test(lower)) return 'document';
  return 'other';
}

export function parseDurationToSeconds(
  duration?: string,
  runtimeMinutes?: string | number
): number {
  if (duration && typeof duration === 'string') {
    const parts = duration
      .trim()
      .split(':')
      .map((p) => Number(p));
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      const total = parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (total > 0) return Math.round(total);
    }
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      const total = parts[0] * 60 + parts[1];
      if (total > 0) return Math.round(total);
    }
  }
  const mins = Number(runtimeMinutes || 0);
  if (Number.isFinite(mins) && mins > 0) {
    return Math.round(mins * 60);
  }
  return -1;
}

export function resolveAbsoluteArtworkUrl(
  file: AndreDriveFile,
  origin: string,
  token?: string
): string {
  const meta = file.metadata || {};
  if (meta.poster_source === 'upload') {
    return token
      ? `${origin}/thumb/${token}/${encodeURIComponent(file.id)}`
      : `${origin}/api/files/${encodeURIComponent(file.id)}/poster`;
  }
  const candidate = meta.poster_url || meta.episode_image_url || file.image || '';
  if (!candidate) return '';
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
    return candidate;
  }
  if (candidate.startsWith('/')) {
    return `${origin}${candidate}`;
  }
  return `${origin}/${candidate}`;
}

function escapeM3uAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .trim();
}

export function buildM3UPlaylist(files: AndreDriveFile[], origin: string, token: string): string {
  const lines: string[] = ['#EXTM3U'];
  for (const file of files) {
    const meta = file.metadata || {};
    const isSeries = file.kind === 'series' || Boolean(file.series);
    const seriesName = (file.series || meta.title || file.name.replace(/\.[^.]+$/, '')).trim();
    const season = Number(file.season) || 1;
    const episode = Number(file.episode) || 1;
    const seCode = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const episodeTitle = String(meta.episode_title || '').trim();
    const year = String(meta.year || '').trim();

    const displayTitle = isSeries
      ? `${seriesName} ${seCode}${episodeTitle ? ` - ${episodeTitle}` : ''}`
      : `${meta.title || file.name.replace(/\.[^.]+$/, '')}${year ? ` (${year})` : ''}`;

    const groupTitle =
      meta.group_title ||
      (isSeries ? `Serien - ${seriesName}` : file.kind === 'movie' ? 'Filme' : 'Videos');
    const logo = resolveAbsoluteArtworkUrl(file, origin, token);
    const durationSec = parseDurationToSeconds(file.duration, meta.runtime_minutes);
    const tvgId =
      meta.tvg_id ||
      (meta.tmdb_id ? `tmdb:${meta.tmdb_id}` : '') ||
      meta.imdb_id ||
      file.id;
    const contentType = isSeries ? 'series' : 'movie';

    const attrs: Array<[string, string]> = [
      ['tvg-id', tvgId],
      ['tvg-name', displayTitle],
      ['tvg-logo', logo],
      ['group-title', groupTitle],
      ['tvg-type', contentType],
      ['type', contentType],
      ['tvg-tmdb', String(meta.tmdb_id || '')],
      ['tvg-imdb', String(meta.imdb_id || '')],
      ['tvg-serie', isSeries ? seriesName : ''],
      ['serie-title', isSeries ? seriesName : ''],
      ['tvg-season', isSeries ? String(season) : ''],
      ['tvg-episode', isSeries ? String(episode) : ''],
      ['year', year],
      ['genre', String(meta.genres || '')],
      ['plot', String(meta.plot || '')],
      ['rating', String(meta.rating || '')],
      ['director', String(meta.director || '')],
      ['cast', String(meta.cast || '')],
      ['country', String(meta.country || '')],
      ['language', String(meta.language || '')],
      ['series', isSeries ? seriesName : ''],
      ['season', isSeries ? String(season) : ''],
      ['episode', isSeries ? String(episode) : ''],
      ['episode-title', episodeTitle],
    ];

    const attrText = attrs
      .filter(([, v]) => Boolean(v && v.trim()))
      .map(([k, v]) => `${k}="${escapeM3uAttr(v)}"`)
      .join(' ');

    lines.push(
      `#EXTINF:${durationSec}${attrText ? ` ${attrText}` : ''},${displayTitle.replace(/[\r\n]+/g, ' ')}`
    );
    if (groupTitle) {
      lines.push(`#EXTGRP:${groupTitle.replace(/[\r\n]+/g, ' ')}`);
    }
    lines.push(`${origin}/media/${token}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`);
  }
  return lines.join('\n') + '\n';
}

// Standard CRC32 + PKZIP archive generator for real multi-file ZIP downloads
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipArchive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const safeName = entry.name.replace(/^[\\/]+/, '') || 'file.dat';
    const nameBuf = Buffer.from(safeName, 'utf-8');
    const data = entry.data;
    const sum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(0, 8); // Store method (0 = uncompressed)
    localHeader.writeUInt16LE(0, 10); // Mod time
    localHeader.writeUInt16LE(0x21, 12); // Mod date
    localHeader.writeUInt32LE(sum, 14); // CRC-32
    localHeader.writeUInt32LE(data.length, 18); // Compressed size
    localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28); // Extra field length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(20, 4); // Version made by
    centralHeader.writeUInt16LE(20, 6); // Version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10); // Store method
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(sum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export class AndreDriveStore {
  private storageFilePath: string | null;
  private backupFilePath: string | null;
  private blobsDirPath: string | null;
  private accounts: Map<string, PersistedAccountSnapshot> = new Map();

  public isLoggedIn: boolean = true;
  public user: AndreDriveUser = {
    id: 'usr-andre-1',
    name: 'Andre',
    email: 'LPAndreU97@gmail.com',
  };
  public folders: AndreDriveFolder[] = structuredClone(INITIAL_FOLDERS);
  public files: AndreDriveFile[] = structuredClone(INITIAL_FILES);
  public trashedFiles: AndreDriveFile[] = [];
  public customCategories: AndreDriveCategory[] = [];
  public links: AndreDriveShareLink[] = [];
  public uploads: Map<string, AndreDriveUploadSession> = new Map();
  public fileBuffers: Map<string, Buffer> = new Map();
  public filePosters: Map<string, { buffer: Buffer; mime: string }> = new Map();

  public jellyfinAccounts: DeviceAccount[] = [];
  public jellyfinSessions: Record<string, JellyfinSessionRecord> = {};
  public jellyfinUserState: Record<string, JellyfinItemUserState> = {};
  public navidromeAccounts: DeviceAccount[] = [];
  public opdsAccounts: DeviceAccount[] = [];
  public audiobookshelfAccounts: DeviceAccount[] = [];
  public webdavAccounts: DeviceAccount[] = [];
  public rommSettings: { server_url: string; folder_id: string; username?: string; password?: string } = {
    server_url: 'http://steamdeck.local:8080',
    folder_id: 'd4',
  };
  public tmdbSettings: { configured: boolean; personal: boolean; token?: string } = {
    configured: true,
    personal: false,
  };
  public cloudConnections: CloudConnection[] = structuredClone(DEFAULT_CLOUD_CONNECTIONS);
  public cloudTransfers: CloudTransferJob[] = [];

  constructor(storageFilePath?: string | null) {
    if (storageFilePath === null) {
      this.storageFilePath = null;
      this.backupFilePath = null;
      this.blobsDirPath = null;
    } else if (storageFilePath !== undefined) {
      this.storageFilePath = storageFilePath;
      this.backupFilePath = `${storageFilePath}.backup`;
      this.blobsDirPath = `${storageFilePath}.blobs`;
    } else {
      const storageDir = path.join(process.cwd(), '.andredrive-storage');
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(process.cwd(), '.andredrive-accounts.json');
      this.backupFilePath = path.join(storageDir, 'accounts.backup.json');
      this.blobsDirPath = path.join(storageDir, 'blobs');
      if (!fs.existsSync(this.blobsDirPath)) {
        fs.mkdirSync(this.blobsDirPath, { recursive: true });
      }
    }
    this.loadFromDisk();
  }

  public getFileBlobPath(fileId: string): string | undefined {
    if (!this.blobsDirPath) return undefined;
    const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const blobPath = path.join(this.blobsDirPath, `${safeId}.bin`);
    if (fs.existsSync(blobPath)) {
      return blobPath;
    }
    return undefined;
  }

  public getFileBlobStat(fileId: string): { path: string; size: number } | undefined {
    const blobPath = this.getFileBlobPath(fileId);
    if (!blobPath) return undefined;
    try {
      const st = fs.statSync(blobPath);
      if (st.isFile() && st.size > 0) {
        return { path: blobPath, size: st.size };
      }
    } catch {
      // Ignore stat errors
    }
    return undefined;
  }

  public saveFileBlob(fileId: string, buffer: Buffer): void {
    if (!this.blobsDirPath || buffer.length <= 5 * 1024 * 1024) {
      this.fileBuffers.set(fileId, buffer);
    } else {
      this.fileBuffers.delete(fileId);
    }
    if (!this.blobsDirPath) return;
    try {
      if (!fs.existsSync(this.blobsDirPath)) {
        fs.mkdirSync(this.blobsDirPath, { recursive: true });
      }
      const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(this.blobsDirPath, `${safeId}.bin`), buffer);
    } catch (err) {
      console.error('Failed to persist file blob to disk:', err);
    }
  }

  public getFileBlob(fileId: string): Buffer | undefined {
    const inMemory = this.fileBuffers.get(fileId);
    if (inMemory) return inMemory;
    if (!this.blobsDirPath) return undefined;
    try {
      const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const blobPath = path.join(this.blobsDirPath, `${safeId}.bin`);
      if (fs.existsSync(blobPath)) {
        const buf = fs.readFileSync(blobPath);
        if (buf.length <= 5 * 1024 * 1024) {
          this.fileBuffers.set(fileId, buf);
        }
        return buf;
      }
    } catch (err) {
      console.error('Failed to read file blob from disk:', err);
    }
    return undefined;
  }

  private captureCurrentAccountSnapshot(): PersistedAccountSnapshot {
    const fileBuffersBase64: Record<string, string> = {};
    for (const [id, buf] of this.fileBuffers.entries()) {
      if (buf.length <= 5 * 1024 * 1024) {
        fileBuffersBase64[id] = buf.toString('base64');
      }
    }
    return {
      user: structuredClone(this.user),
      folders: structuredClone(this.folders),
      files: structuredClone(this.files),
      trashedFiles: structuredClone(this.trashedFiles),
      customCategories: structuredClone(this.customCategories),
      links: structuredClone(this.links),
      fileBuffersBase64,
      jellyfinAccounts: structuredClone(this.jellyfinAccounts),
      jellyfinSessions: structuredClone(this.jellyfinSessions),
      jellyfinUserState: structuredClone(this.jellyfinUserState),
      navidromeAccounts: structuredClone(this.navidromeAccounts),
      opdsAccounts: structuredClone(this.opdsAccounts),
      audiobookshelfAccounts: structuredClone(this.audiobookshelfAccounts),
      webdavAccounts: structuredClone(this.webdavAccounts),
      rommSettings: structuredClone(this.rommSettings),
      tmdbSettings: structuredClone(this.tmdbSettings),
      cloudConnections: structuredClone(this.cloudConnections),
      cloudTransfers: structuredClone(this.cloudTransfers),
    };
  }

  private applyAccountSnapshot(snapshot: PersistedAccountSnapshot): void {
    this.user = structuredClone(snapshot.user);

    // Merge INITIAL_FOLDERS non-destructively so user folders are always kept
    const loadedFolders = structuredClone(snapshot.folders || INITIAL_FOLDERS);
    const folderIds = new Set(loadedFolders.map((f) => f.id));
    for (const initFolder of INITIAL_FOLDERS) {
      if (!folderIds.has(initFolder.id)) {
        loadedFolders.push(structuredClone(initFolder));
      }
    }
    this.folders = loadedFolders;

    // Filter out removed placeholder demo files and upgrade real uploaded files
    this.files = upgradeRealUploadedFiles(snapshot.files || []);
    this.trashedFiles = (snapshot.trashedFiles || [])
      .filter((f) => f && f.id && !isPlaceholderFileId(f.id))
      .map((f) => structuredClone(f));
    this.customCategories = structuredClone(snapshot.customCategories || []);
    this.links = structuredClone(snapshot.links || []);
    this.fileBuffers.clear();
    if (snapshot.fileBuffersBase64) {
      for (const [id, b64] of Object.entries(snapshot.fileBuffersBase64)) {
        if (!isPlaceholderFileId(id)) {
          this.fileBuffers.set(id, Buffer.from(b64, 'base64'));
        }
      }
    }
    this.jellyfinAccounts = structuredClone(snapshot.jellyfinAccounts || []);
    this.jellyfinSessions = structuredClone(snapshot.jellyfinSessions || {});
    this.jellyfinUserState = structuredClone(snapshot.jellyfinUserState || {});
    this.navidromeAccounts = structuredClone(snapshot.navidromeAccounts || []);
    this.opdsAccounts = structuredClone(snapshot.opdsAccounts || []);
    this.audiobookshelfAccounts = structuredClone(snapshot.audiobookshelfAccounts || []);
    this.webdavAccounts = structuredClone(snapshot.webdavAccounts || []);
    this.rommSettings = structuredClone(
      snapshot.rommSettings || {
        server_url: 'http://steamdeck.local:8080',
        folder_id: 'd4',
      }
    );
    this.tmdbSettings = structuredClone(
      snapshot.tmdbSettings || {
        configured: true,
        personal: false,
      }
    );
    this.cloudConnections = structuredClone(
      snapshot.cloudConnections || DEFAULT_CLOUD_CONNECTIONS
    );
    this.cloudTransfers = structuredClone(snapshot.cloudTransfers || []);
  }

  public saveToDisk(): void {
    const snap = this.captureCurrentAccountSnapshot();
    this.accounts.set(this.user.id, snap);
    if (!this.storageFilePath) return;
    try {
      const accountsObj: Record<string, PersistedAccountSnapshot> = {};
      for (const [id, accountSnap] of this.accounts.entries()) {
        accountsObj[id] = accountSnap;
      }
      const payload: PersistedDiskStore = {
        activeUserId: this.user.id,
        isLoggedIn: this.isLoggedIn,
        accounts: accountsObj,
      };
      const serialized = JSON.stringify(payload, null, 2);
      fs.writeFileSync(this.storageFilePath, serialized, 'utf-8');
      if (this.backupFilePath) {
        fs.writeFileSync(this.backupFilePath, serialized, 'utf-8');
      }
    } catch (err) {
      console.error('Failed to persist AndreDrive store to disk:', err);
    }
  }

  public loadFromDisk(): void {
    if (!this.storageFilePath) {
      this.accounts.set(this.user.id, this.captureCurrentAccountSnapshot());
      return;
    }
    const candidatePath = fs.existsSync(this.storageFilePath)
      ? this.storageFilePath
      : this.backupFilePath && fs.existsSync(this.backupFilePath)
      ? this.backupFilePath
      : null;

    if (!candidatePath) {
      this.accounts.set(this.user.id, this.captureCurrentAccountSnapshot());
      this.saveToDisk();
      return;
    }
    try {
      const raw = fs.readFileSync(candidatePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedDiskStore;
      if (parsed && parsed.accounts && typeof parsed.accounts === 'object') {
        this.accounts.clear();
        for (const [id, snap] of Object.entries(parsed.accounts)) {
          this.accounts.set(id, snap);
        }
        const targetId = parsed.activeUserId || 'usr-andre-1';
        const activeSnap = this.accounts.get(targetId);
        if (activeSnap) {
          this.applyAccountSnapshot(activeSnap);
        }
        if (typeof parsed.isLoggedIn === 'boolean') {
          this.isLoggedIn = parsed.isLoggedIn;
        }
        // Ensure both primary and backup files are synced
        this.saveToDisk();
      }
    } catch (err) {
      console.error('Failed to load AndreDrive store from disk:', err);
    }
  }

  public restoreClientVault(vault: {
    files?: AndreDriveFile[];
    folders?: AndreDriveFolder[];
    links?: AndreDriveShareLink[];
    categories?: AndreDriveCategory[];
  }): boolean {
    let changed = false;
    const trashedIds = new Set(this.trashedFiles.map((f) => f.id));

    if (Array.isArray(vault.folders)) {
      const existingFolderMap = new Map(this.folders.map((f) => [f.id, f]));
      for (const incomingFolder of vault.folders) {
        if (!incomingFolder || !incomingFolder.id) continue;
        if (!existingFolderMap.has(incomingFolder.id)) {
          this.folders.push({
            id: String(incomingFolder.id),
            name: String(incomingFolder.name || 'Ordner'),
            parent: incomingFolder.parent || null,
            color: incomingFolder.color || 'green',
          });
          changed = true;
        }
      }
    }

    if (Array.isArray(vault.categories)) {
      const existingCatIds = new Set(this.getCategories().map((c) => c.id));
      for (const cat of vault.categories) {
        if (!cat || !cat.id || cat.builtin) continue;
        if (!existingCatIds.has(cat.id)) {
          this.customCategories.push({
            id: String(cat.id),
            name: String(cat.name || 'Kategorie'),
            icon: String(cat.icon || 'folder'),
            builtin: false,
          });
          existingCatIds.add(cat.id);
          changed = true;
        }
      }
    }

    if (Array.isArray(vault.files)) {
      const cleanedIncoming = upgradeRealUploadedFiles(vault.files);
      const existingFileMap = new Map(this.files.map((f) => [f.id, f]));
      for (const incomingFile of cleanedIncoming) {
        if (!incomingFile || !incomingFile.id || trashedIds.has(incomingFile.id)) continue;
        const existing = existingFileMap.get(incomingFile.id);
        if (!existing) {
          this.files.unshift(structuredClone(incomingFile));
          existingFileMap.set(incomingFile.id, incomingFile);
          changed = true;
        } else if (incomingFile.metadata && Object.keys(incomingFile.metadata).length > 0) {
          const curMeta = existing.metadata || {};
          const mergedMeta: AndreDriveFileMetadata = { ...incomingFile.metadata, ...curMeta };
          if (
            curMeta.poster_url === '/images/alpine-escape.jpg' &&
            incomingFile.metadata.poster_url &&
            incomingFile.metadata.poster_url !== '/images/alpine-escape.jpg'
          ) {
            mergedMeta.poster_url = incomingFile.metadata.poster_url;
          }
          if (
            curMeta.episode_image_url === '/images/alpine-escape.jpg' &&
            incomingFile.metadata.episode_image_url &&
            incomingFile.metadata.episode_image_url !== '/images/alpine-escape.jpg'
          ) {
            mergedMeta.episode_image_url = incomingFile.metadata.episode_image_url;
          }
          if (JSON.stringify(mergedMeta) !== JSON.stringify(curMeta)) {
            existing.metadata = mergedMeta;
            changed = true;
          }
        }
      }
    }

    if (Array.isArray(vault.links)) {
      const existingTokens = new Set(this.links.map((l) => l.token));
      for (const incomingLink of vault.links) {
        if (!incomingLink || !incomingLink.token) continue;
        if (!existingTokens.has(incomingLink.token)) {
          this.links.push(structuredClone(incomingLink));
          existingTokens.add(incomingLink.token);
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveToDisk();
    }
    return changed;
  }

  public login(requestedUser?: Partial<AndreDriveUser>): AndreDriveUser {
    this.accounts.set(this.user.id, this.captureCurrentAccountSnapshot());

    const targetId = String(requestedUser?.id || this.user.id || 'usr-andre-1').trim();
    const existing = this.accounts.get(targetId);

    if (existing) {
      if (requestedUser?.name) existing.user.name = String(requestedUser.name).trim();
      if (requestedUser?.email) existing.user.email = String(requestedUser.email).trim();
      this.applyAccountSnapshot(existing);
    } else {
      const newUser: AndreDriveUser = {
        id: targetId,
        name: String(requestedUser?.name || 'Andre').trim(),
        email: String(requestedUser?.email || 'LPAndreU97@gmail.com').trim(),
      };
      this.user = newUser;
      this.folders = structuredClone(INITIAL_FOLDERS);
      this.files = structuredClone(INITIAL_FILES);
      this.trashedFiles = [];
      this.customCategories = [];
      this.links = [];
      this.fileBuffers.clear();
      this.jellyfinAccounts = [];
      this.jellyfinSessions = {};
      this.jellyfinUserState = {};
      this.navidromeAccounts = [];
      this.opdsAccounts = [];
      this.audiobookshelfAccounts = [];
      this.webdavAccounts = [];
      this.cloudConnections = structuredClone(DEFAULT_CLOUD_CONNECTIONS);
      this.cloudTransfers = [];
    }

    this.isLoggedIn = true;
    this.saveToDisk();
    return this.user;
  }

  public logout(): void {
    this.saveToDisk();
    this.isLoggedIn = false;
    this.saveToDisk();
  }

  public getCategories(): AndreDriveCategory[] {
    return [...BUILTIN_CATEGORIES, ...this.customCategories];
  }

  public getLibrary() {
    const categories = this.getCategories();
    const catMap = new Map(categories.map((c) => [c.id, c.name]));
    const enrichedFiles = this.files.map((f) => ({
      ...f,
      category_name: catMap.get(f.kind) || 'Sonstiges',
    }));
    const enrichedFolders = this.folders.map((folder) => ({
      ...folder,
      count: enrichedFiles.filter((f) => f.folder === folder.id).length,
    }));
    return {
      files: enrichedFiles,
      folders: enrichedFolders,
      links: this.links,
      categories,
    };
  }

  public createFolder(name: string, parent: string | null = null): AndreDriveFolder {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      throw new Error('Bitte gib einen Ordnernamen ein.');
    }
    const colors: Array<'green' | 'purple' | 'orange' | 'blue'> = ['green', 'purple', 'orange', 'blue'];
    const folder: AndreDriveFolder = {
      id: 'fld-' + crypto.randomBytes(6).toString('hex'),
      name: cleanName,
      parent: parent || null,
      color: colors[this.folders.length % colors.length],
    };
    this.folders.push(folder);
    this.saveToDisk();
    return folder;
  }

  public createShareLink(type: AndreDriveShareLink['type'], target: unknown): AndreDriveShareLink {
    const normalizedTarget =
      Array.isArray(target) ? JSON.stringify(target) : String(target || '');
    const existing = this.links.find((l) => l.type === type && l.target === normalizedTarget);
    if (existing) return existing;

    const link: AndreDriveShareLink = {
      token: generateShareToken(),
      type,
      target: normalizedTarget,
      created: new Date().toISOString(),
    };
    this.links.unshift(link);
    this.saveToDisk();
    return link;
  }

  public deleteShareLink(token: string): boolean {
    const before = this.links.length;
    this.links = this.links.filter((l) => l.token !== token);
    const changed = this.links.length < before;
    if (changed) this.saveToDisk();
    return changed;
  }

  public createDeviceAccount(
    list: DeviceAccount[],
    label: string,
    prefix: string,
    canWrite?: boolean
  ): DeviceAccount {
    const userPrefix = prefix === 'dav' ? 'ad' : prefix;
    const account: DeviceAccount = {
      id: crypto.randomBytes(16).toString('hex'),
      label: String(label || 'Mein Gerät').trim() || 'Mein Gerät',
      username: `${userPrefix}_${crypto.randomBytes(5).toString('hex')}`,
      password: crypto.randomBytes(32).toString('hex'),
      ...(canWrite !== undefined ? { can_write: Boolean(canWrite) } : {}),
      created: new Date().toISOString(),
      last_used: null,
    };
    list.unshift(account);
    this.saveToDisk();
    return account;
  }
}
