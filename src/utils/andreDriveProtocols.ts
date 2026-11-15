import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  AndreDriveStore,
  AndreDriveFile,
  DeviceAccount,
  parseDurationToSeconds,
  resolveAbsoluteArtworkUrl,
  buildM3UPlaylist,
} from './andreDriveBackend.ts';
import { getPublicOrigin } from './tunnelService.ts';

const JELLYFIN_SERVER_ID = '416e64726544726976654a656c6c7931'; // 32-char hex
const JELLYFIN_SERVER_NAME = 'AndreDrive Media Server';
const JELLYFIN_VERSION = '10.9.11';
const VIEW_MOVIES_ID = '416e64726544726976654d6f76696573'; // 32-char hex
const VIEW_SERIES_ID = '416e6472654472697665536572696573'; // 32-char hex

export function jellyHexId(seed: string): string {
  return crypto.createHash('md5').update(`andredrive:${seed}`).digest('hex');
}

export function normalizeJellyId(rawId: string | undefined | null): string {
  const cleaned = String(rawId || '').trim();
  const compact = cleaned.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(compact)) {
    return compact;
  }
  return cleaned;
}

function getOrigin(req: express.Request): string {
  return getPublicOrigin(req);
}

function setJellyfinCors(res: express.Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Range, If-Range, Accept'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, ETag, X-Application-Version'
  );
  res.setHeader('X-Application-Version', JELLYFIN_VERSION);
}

function parseEmbyAuthHeader(req: express.Request): {
  token: string;
  client: string;
  device: string;
  deviceId: string;
  version: string;
} {
  const header =
    req.get('X-Emby-Authorization') ||
    req.get('Authorization') ||
    '';
  const pick = (name: string): string => {
    const quoted = new RegExp(`${name}="([^"]*)"`, 'i').exec(header);
    if (quoted) return quoted[1];
    const plain = new RegExp(`${name}=([^,\\s]+)`, 'i').exec(header);
    return plain ? plain[1] : '';
  };
  const directToken =
    req.get('X-Emby-Token') ||
    req.get('X-MediaBrowser-Token') ||
    String(req.query.api_key || req.query.ApiKey || '').trim() ||
    (/^Bearer\s+([^\s,]+)$/i.exec(header)?.[1] ?? '');

  return {
    token: directToken || pick('Token'),
    client: pick('Client') || 'Jellyfin Client',
    device: pick('Device') || 'Gerät',
    deviceId: pick('DeviceId') || 'andredrive-device',
    version: pick('Version') || '1.0.0',
  };
}

function fileDurationTicks(file: AndreDriveFile): number {
  const sec = parseDurationToSeconds(file.duration, file.metadata?.runtime_minutes);
  const effectiveSec = sec > 0 ? sec : 2917;
  return Math.round(effectiveSec * 10_000_000);
}

function fileContainer(file: AndreDriveFile): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(file.name || '');
  return m ? m[1].toLowerCase() : 'mp4';
}

function splitList(raw: unknown): string[] {
  return String(raw || '')
    .split(/[,;|/]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function getVideoFiles(store: AndreDriveStore): AndreDriveFile[] {
  return store.files.filter(
    (f) =>
      !f.deleted &&
      (f.kind === 'movie' ||
        f.kind === 'series' ||
        (f.mime || '').startsWith('video/') ||
        /\.(mp4|mkv|webm|mov|avi|m4v|ts)$/i.test(f.name || ''))
  );
}

function isSeriesEpisode(file: AndreDriveFile): boolean {
  return file.kind === 'series' || Boolean((file.series || '').trim());
}

function seriesTitleFor(file: AndreDriveFile): string {
  return (
    (file.series || '').trim() ||
    (file.metadata?.title || '').trim() ||
    file.name.replace(/\s*S\d{1,2}E\d{1,3}.*$/i, '').replace(/\.[^.]+$/, '').trim() ||
    'Serie'
  );
}

interface SeriesGroup {
  id: string;
  key: string;
  name: string;
  episodes: AndreDriveFile[];
  seasons: Map<number, AndreDriveFile[]>;
  primaryFile: AndreDriveFile;
}

function buildSeriesGroups(files: AndreDriveFile[]): SeriesGroup[] {
  const groups = new Map<string, SeriesGroup>();
  for (const file of files.filter(isSeriesEpisode)) {
    const name = seriesTitleFor(file);
    const key = name.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        id: jellyHexId(`series:${key}`),
        key,
        name,
        episodes: [],
        seasons: new Map<number, AndreDriveFile[]>(),
        primaryFile: file,
      };
      groups.set(key, group);
    }
    group.episodes.push(file);
    const seasonNo = Math.max(1, Number(file.season) || 1);
    const seasonList = group.seasons.get(seasonNo) || [];
    seasonList.push(file);
    group.seasons.set(seasonNo, seasonList);
  }

  for (const group of groups.values()) {
    group.episodes.sort(
      (a, b) =>
        (Number(a.season) || 1) - (Number(b.season) || 1) ||
        (Number(a.episode) || 1) - (Number(b.episode) || 1) ||
        a.name.localeCompare(b.name)
    );
    for (const list of group.seasons.values()) {
      list.sort(
        (a, b) =>
          (Number(a.episode) || 1) - (Number(b.episode) || 1) ||
          a.name.localeCompare(b.name)
      );
    }
    group.primaryFile = group.episodes[0] || group.primaryFile;
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function seasonIdFor(seriesKey: string, seasonNumber: number): string {
  return jellyHexId(`season:${seriesKey}:${seasonNumber}`);
}

function findFileByJellyfinId(store: AndreDriveStore, rawId: string): AndreDriveFile | undefined {
  const norm = normalizeJellyId(rawId);
  for (const f of store.files) {
    if (f.id === rawId || f.id === norm || jellyHexId(`file:${f.id}`) === norm) {
      return f;
    }
  }
  return undefined;
}

function userDataDto(store: AndreDriveStore, itemId: string) {
  const norm = normalizeJellyId(itemId);
  const state = store.jellyfinUserState[norm] || {
    played: false,
    playCount: 0,
    positionTicks: 0,
    favorite: false,
  };
  return {
    PlaybackPositionTicks: Number(state.positionTicks || 0),
    PlayCount: Number(state.playCount || 0),
    IsFavorite: Boolean(state.favorite),
    Played: Boolean(state.played),
    LastPlayedDate: state.lastPlayed || null,
    Key: norm,
    ItemId: norm,
  };
}

function mediaSourceForFile(file: AndreDriveFile, itemHexId: string) {
  const ticks = fileDurationTicks(file);
  const container = fileContainer(file);
  const size = Number(file.size || 0);
  const seconds = Math.max(1, ticks / 10_000_000);
  const bitrate = size > 0 ? Math.max(400_000, Math.round((size * 8) / seconds)) : 4_000_000;
  const is4k = /4k|2160/i.test(file.quality || '');
  const width = is4k ? 3840 : 1920;
  const height = is4k ? 2160 : 1080;

  return {
    Protocol: 'File',
    Id: itemHexId,
    Path: `/Videos/${itemHexId}/stream.${container}`,
    Type: 'Default',
    Container: container,
    Size: size,
    Name: file.metadata?.title || file.name,
    IsRemote: false,
    ETag: itemHexId,
    RunTimeTicks: ticks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: true,
    VideoType: 'VideoFile',
    Bitrate: bitrate,
    DirectStreamUrl: `/Videos/${itemHexId}/stream.${container}?Static=true`,
    DefaultAudioStreamIndex: 1,
    MediaStreams: [
      {
        Codec: 'h264',
        Language: file.metadata?.language || 'deu',
        TimeBase: '1/90000',
        VideoRange: 'SDR',
        VideoRangeType: 'SDR',
        DisplayTitle: `${is4k ? '4K' : '1080p'} H264 SDR`,
        IsInterlaced: false,
        BitRate: bitrate,
        BitDepth: 8,
        Width: width,
        Height: height,
        AverageFrameRate: 25,
        RealFrameRate: 25,
        Profile: 'High',
        Type: 'Video',
        AspectRatio: '16:9',
        Index: 0,
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        PixelFormat: 'yuv420p',
        Level: 41,
      },
      {
        Codec: 'aac',
        Language: file.metadata?.language || 'deu',
        TimeBase: '1/48000',
        DisplayTitle: 'Deutsch AAC Stereo',
        IsInterlaced: false,
        ChannelLayout: 'stereo',
        BitRate: 192000,
        Channels: 2,
        SampleRate: 48000,
        Profile: 'LC',
        Type: 'Audio',
        Index: 1,
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
      },
    ],
    Formats: [],
    RequiredHttpHeaders: {},
  };
}

function providerIdsFor(meta: AndreDriveFile['metadata']): Record<string, string> {
  const ids: Record<string, string> = {};
  if (meta?.tmdb_id) ids.Tmdb = String(meta.tmdb_id);
  if (meta?.imdb_id) ids.Imdb = String(meta.imdb_id);
  return ids;
}

function peopleFor(meta: AndreDriveFile['metadata']) {
  const out: Array<{ Name: string; Id: string; Role: string; Type: string }> = [];
  for (const name of splitList(meta?.director)) {
    out.push({
      Name: name,
      Id: jellyHexId(`person:${name.toLowerCase()}`),
      Role: 'Regie',
      Type: 'Director',
    });
  }
  for (const name of splitList(meta?.cast)) {
    out.push({
      Name: name,
      Id: jellyHexId(`person:${name.toLowerCase()}`),
      Role: '',
      Type: 'Actor',
    });
  }
  return out;
}

function genreItemsFor(meta: AndreDriveFile['metadata']) {
  const genres = splitList(meta?.genres);
  return {
    Genres: genres,
    GenreItems: genres.map((name) => ({
      Name: name,
      Id: jellyHexId(`genre:${name.toLowerCase()}`),
    })),
  };
}

function buildMovieDto(store: AndreDriveStore, file: AndreDriveFile) {
  const meta = file.metadata || {};
  const itemHexId = jellyHexId(`file:${file.id}`);
  const title = (meta.title || file.name.replace(/\.[^.]+$/, '')).trim();
  const year = Number(meta.year) || undefined;
  const rating = Number(meta.rating);
  const ticks = fileDurationTicks(file);
  const { Genres, GenreItems } = genreItemsFor(meta);
  const hasImage = Boolean(meta.poster_url || meta.episode_image_url || file.image || store.filePosters.has(file.id));
  const tag = itemHexId.slice(0, 12);

  return {
    Name: title,
    OriginalTitle: meta.original_title || title,
    ServerId: JELLYFIN_SERVER_ID,
    Id: itemHexId,
    Etag: itemHexId,
    SourceType: 'Library',
    DateCreated: file.created || new Date().toISOString(),
    PremiereDate: year ? `${year}-01-01T00:00:00.000Z` : file.created || new Date().toISOString(),
    ProductionYear: year,
    Overview: meta.plot || '',
    Taglines: [],
    Genres,
    GenreItems,
    CommunityRating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    RunTimeTicks: ticks,
    PlayAccess: 'Full',
    IsFolder: false,
    ParentId: VIEW_MOVIES_ID,
    Type: 'Movie',
    MediaType: 'Video',
    LocationType: 'FileSystem',
    VideoType: 'VideoFile',
    Path: `/${file.name}`,
    Container: fileContainer(file),
    CanDownload: true,
    CanDelete: false,
    SupportsSync: true,
    HasSubtitles: false,
    People: peopleFor(meta),
    Studios: [],
    ProviderIds: providerIdsFor(meta),
    ProductionLocations: meta.country ? [meta.country] : [],
    MediaSources: [mediaSourceForFile(file, itemHexId)],
    MediaStreams: mediaSourceForFile(file, itemHexId).MediaStreams,
    UserData: userDataDto(store, itemHexId),
    ImageTags: hasImage ? { Primary: tag, Thumb: tag } : {},
    BackdropImageTags: hasImage ? [tag] : [],
    PrimaryImageAspectRatio: 0.6666667,
  };
}

function buildSeriesDto(store: AndreDriveStore, group: SeriesGroup) {
  const file = group.primaryFile;
  const meta = file?.metadata || {};
  const year = Number(meta.year) || undefined;
  const rating = Number(meta.rating);
  const { Genres, GenreItems } = genreItemsFor(meta);
  const hasImage = Boolean(meta.poster_url || meta.episode_image_url || file?.image);
  const tag = group.id.slice(0, 12);

  return {
    Name: group.name,
    OriginalTitle: meta.original_title || group.name,
    ServerId: JELLYFIN_SERVER_ID,
    Id: group.id,
    Etag: group.id,
    DateCreated: file?.created || new Date().toISOString(),
    PremiereDate: year ? `${year}-01-01T00:00:00.000Z` : file?.created || new Date().toISOString(),
    ProductionYear: year,
    Overview: meta.plot || '',
    Status: 'Continuing',
    AirDays: [],
    Genres,
    GenreItems,
    CommunityRating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    RunTimeTicks: file ? fileDurationTicks(file) : 29170000000,
    PlayAccess: 'Full',
    IsFolder: true,
    ParentId: VIEW_SERIES_ID,
    Type: 'Series',
    LocationType: 'FileSystem',
    ChildCount: group.seasons.size,
    RecursiveItemCount: group.episodes.length,
    People: peopleFor(meta),
    Studios: [],
    ProviderIds: providerIdsFor(meta),
    UserData: {
      ...userDataDto(store, group.id),
      UnplayedItemCount: group.episodes.length,
    },
    ImageTags: hasImage ? { Primary: tag, Thumb: tag } : {},
    BackdropImageTags: hasImage ? [tag] : [],
    PrimaryImageAspectRatio: 0.6666667,
  };
}

function buildSeasonDto(
  store: AndreDriveStore,
  group: SeriesGroup,
  seasonNumber: number,
  episodes: AndreDriveFile[]
) {
  const id = seasonIdFor(group.key, seasonNumber);
  const first = episodes[0] || group.primaryFile;
  const meta = first?.metadata || {};
  const hasImage = Boolean(meta.poster_url || meta.episode_image_url || first?.image);
  const tag = id.slice(0, 12);

  return {
    Name: `Staffel ${seasonNumber}`,
    ServerId: JELLYFIN_SERVER_ID,
    Id: id,
    Etag: id,
    DateCreated: first?.created || new Date().toISOString(),
    IndexNumber: seasonNumber,
    IsFolder: true,
    ParentId: group.id,
    SeriesId: group.id,
    SeriesName: group.name,
    SeriesPrimaryImageTag: group.id.slice(0, 12),
    Type: 'Season',
    LocationType: 'FileSystem',
    PlayAccess: 'Full',
    ChildCount: episodes.length,
    RecursiveItemCount: episodes.length,
    UserData: {
      ...userDataDto(store, id),
      UnplayedItemCount: episodes.length,
    },
    ImageTags: hasImage ? { Primary: tag, Thumb: tag } : {},
    BackdropImageTags: hasImage ? [tag] : [],
    PrimaryImageAspectRatio: 0.6666667,
  };
}

function buildEpisodeDto(store: AndreDriveStore, group: SeriesGroup, file: AndreDriveFile) {
  const meta = file.metadata || {};
  const itemHexId = jellyHexId(`file:${file.id}`);
  const seasonNumber = Math.max(1, Number(file.season) || 1);
  const episodeNumber = Math.max(1, Number(file.episode) || 1);
  const seasonId = seasonIdFor(group.key, seasonNumber);
  const epTitle = (meta.episode_title || '').trim() || `Episode ${episodeNumber}`;
  const year = Number(meta.year) || undefined;
  const rating = Number(meta.rating);
  const ticks = fileDurationTicks(file);
  const { Genres, GenreItems } = genreItemsFor(meta);
  const hasImage = Boolean(meta.episode_image_url || meta.poster_url || file.image);
  const tag = itemHexId.slice(0, 12);

  return {
    Name: epTitle,
    OriginalTitle: meta.original_title || epTitle,
    ServerId: JELLYFIN_SERVER_ID,
    Id: itemHexId,
    Etag: itemHexId,
    DateCreated: file.created || new Date().toISOString(),
    PremiereDate: year ? `${year}-01-01T00:00:00.000Z` : file.created || new Date().toISOString(),
    ProductionYear: year,
    IndexNumber: episodeNumber,
    ParentIndexNumber: seasonNumber,
    Overview: meta.plot || '',
    Genres,
    GenreItems,
    CommunityRating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    RunTimeTicks: ticks,
    PlayAccess: 'Full',
    IsFolder: false,
    ParentId: seasonId,
    SeasonId: seasonId,
    SeasonName: `Staffel ${seasonNumber}`,
    SeriesId: group.id,
    SeriesName: group.name,
    SeriesPrimaryImageTag: group.id.slice(0, 12),
    ParentBackdropItemId: group.id,
    ParentBackdropImageTags: [group.id.slice(0, 12)],
    Type: 'Episode',
    MediaType: 'Video',
    LocationType: 'FileSystem',
    VideoType: 'VideoFile',
    Path: `/${group.name}/Season ${seasonNumber}/${file.name}`,
    Container: fileContainer(file),
    CanDownload: true,
    CanDelete: false,
    SupportsSync: true,
    HasSubtitles: false,
    People: peopleFor(meta),
    ProviderIds: providerIdsFor(meta),
    MediaSources: [mediaSourceForFile(file, itemHexId)],
    MediaStreams: mediaSourceForFile(file, itemHexId).MediaStreams,
    UserData: userDataDto(store, itemHexId),
    ImageTags: hasImage ? { Primary: tag, Thumb: tag } : {},
    BackdropImageTags: hasImage ? [tag] : [],
    PrimaryImageAspectRatio: 1.7777778,
  };
}

function buildViewDto(id: string, name: string, collectionType: 'movies' | 'tvshows', childCount: number) {
  return {
    Name: name,
    ServerId: JELLYFIN_SERVER_ID,
    Id: id,
    Etag: id,
    DateCreated: '2026-01-01T00:00:00.000Z',
    CanDelete: false,
    CanDownload: false,
    SortName: name.toLowerCase(),
    ForcedSortName: name.toLowerCase(),
    ExternalUrls: [],
    Path: `/${collectionType}`,
    EnableMediaSourceDisplay: true,
    ChannelId: null,
    Taglines: [],
    Genres: [],
    PlayAccess: 'Full',
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: null,
    Type: 'CollectionFolder',
    CollectionType: collectionType,
    ViewType: collectionType,
    LocationType: 'FileSystem',
    ChildCount: childCount,
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: false,
      Key: id,
      ItemId: id,
    },
    ImageTags: {},
    BackdropImageTags: [],
    LockedFields: [],
    LockData: false,
  };
}

function buildUserDto(userId: string, username: string) {
  const now = new Date().toISOString();
  return {
    Name: username,
    ServerId: JELLYFIN_SERVER_ID,
    ServerName: JELLYFIN_SERVER_NAME,
    Id: userId,
    PrimaryImageTag: null,
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: 'deu',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [VIEW_MOVIES_ID, VIEW_SERIES_ID],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: false,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: false,
      IsDisabled: false,
      EnableSharedDeviceControl: true,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      EnableContentDeletion: false,
      EnableContentDownloading: true,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [VIEW_MOVIES_ID, VIEW_SERIES_ID],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
      SyncPlayAccess: 'CreateAndJoinGroups',
    },
  };
}

async function sendArtworkForFile(
  req: express.Request,
  res: express.Response,
  store: AndreDriveStore,
  file: AndreDriveFile | undefined,
  postersCacheDir: string
): Promise<void> {
  if (!file) {
    res.redirect('/images/alpine-escape.jpg');
    return;
  }

  // 1. Check uploaded poster buffer first
  const uploaded = store.filePosters.get(file.id);
  if (uploaded && uploaded.buffer.length > 0) {
    res.setHeader('Content-Type', uploaded.mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).send(uploaded.buffer);
    return;
  }

  // 2. Check metadata URLs or file.image
  const imageType = String(req.params.imageType || 'Primary').toLowerCase();
  const meta = file.metadata || {};
  const rawCandidate =
    imageType === 'backdrop' || imageType === 'thumb'
      ? meta.episode_image_url || meta.poster_url || file.image || ''
      : meta.poster_url || meta.episode_image_url || file.image || '';

  // Extract underlying URL if proxied via /api/tmdb/image?url=...
  let upstreamUrl = rawCandidate;
  if (rawCandidate.startsWith('/api/tmdb/image')) {
    try {
      const u = new URL(rawCandidate, 'http://localhost');
      const inner = u.searchParams.get('url');
      if (inner) upstreamUrl = inner;
    } catch {
      // Ignore parse errors
    }
  }

  if (upstreamUrl.startsWith('http://') || upstreamUrl.startsWith('https://')) {
    const hash = crypto.createHash('sha256').update(upstreamUrl).digest('hex');
    const cacheDataPath = path.join(postersCacheDir, `${hash}.img`);
    const cacheMimePath = path.join(postersCacheDir, `${hash}.mime`);

    try {
      if (fs.existsSync(cacheDataPath)) {
        const mime = fs.existsSync(cacheMimePath)
          ? fs.readFileSync(cacheMimePath, 'utf-8').trim()
          : 'image/jpeg';
        const buf = fs.readFileSync(cacheDataPath);
        if (buf.length > 0) {
          res.setHeader('Content-Type', mime);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.status(200).send(buf);
          return;
        }
      }

      const upstream = await fetch(upstreamUrl, {
        headers: {
          'User-Agent': 'AndreDrive/2.0 (Cloud Media Server)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (upstream.ok) {
        const contentType = upstream.headers.get('content-type') || 'image/jpeg';
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > 0) {
          fs.writeFileSync(cacheDataPath, buf);
          fs.writeFileSync(cacheMimePath, contentType, 'utf-8');
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.status(200).send(buf);
          return;
        }
      }
    } catch {
      // Fallback below
    }
  }

  // Fallback to local static image
  const fallbackPath = path.join(process.cwd(), 'public', 'images', 'alpine-escape.jpg');
  if (fs.existsSync(fallbackPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.status(200).send(fs.readFileSync(fallbackPath));
    return;
  }
  res.status(404).end();
}

export function registerProtocolRoutes(
  app: express.Express,
  store: AndreDriveStore,
  serveFileContent: (req: express.Request, res: express.Response, fileId: string) => Promise<void>,
  postersCacheDir: string
): void {
  // ============================================================================
  // 1. SHARED MEDIA, THUMBNAILS & XTREAM CODES VOD API
  // ============================================================================

  const resolveShareTokenFromXtream = (username: string, password: string): string | null => {
    const u = String(username || '').trim();
    const p = String(password || '').trim();
    if (!u && !p) return null;

    // 1. Combined 32+32 hex token
    const combined = `${u}${p}`;
    const directMatch = store.links.find(
      (l) => l.token === combined || l.token === u || l.token === p
    );
    if (directMatch) return directMatch.token;

    // 2. Match against any Jellyfin or WebDAV device account
    const deviceMatch = [...store.jellyfinAccounts, ...store.webdavAccounts].find(
      (acc) => acc.username.toLowerCase() === u.toLowerCase() && acc.password === p
    );
    if (deviceMatch) {
      if (store.links.length > 0) return store.links[0].token;
      const autoLink = store.createShareLink(
        'playlist',
        store.files.map((f) => f.id)
      );
      return autoLink.token;
    }

    // 3. If token is 64 hex chars, allow access to current video library
    if (/^[a-f0-9]{64}$/i.test(combined)) {
      return combined;
    }
    return null;
  };

  const getSharedFilesForToken = (token: string): AndreDriveFile[] => {
    const link = store.links.find((l) => l.token === token);
    if (!link) {
      return getVideoFiles(store);
    }
    if (link.type === 'file') {
      const f = store.files.find((x) => x.id === link.target);
      return f ? [f] : [];
    }
    if (link.type === 'folder') {
      return store.files.filter((x) => x.folder === link.target);
    }
    try {
      const ids: string[] = JSON.parse(link.target);
      if (Array.isArray(ids) && ids.length > 0) {
        const filtered = store.files.filter((x) => ids.includes(x.id));
        if (filtered.length > 0) return filtered;
      }
    } catch {
      // Fallback to all videos
    }
    return getVideoFiles(store);
  };

  const setMediaCors = (res: express.Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, Content-Type, Accept, Authorization');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Disposition'
    );
  };

  app.options(['/media/:token/:id', '/media/:token/:id/:filename', '/thumb/:token/:id', '/playlist/:token/*'], (_req, res) => {
    setMediaCors(res);
    res.status(204).end();
  });

  app.get(['/media/:token/:id', '/media/:token/:id/:filename'], async (req, res) => {
    setMediaCors(res);
    await serveFileContent(req, res, req.params.id);
  });

  app.head(['/media/:token/:id', '/media/:token/:id/:filename'], async (req, res) => {
    setMediaCors(res);
    await serveFileContent(req, res, req.params.id);
  });

  app.get('/thumb/:token/:id', async (req, res) => {
    setMediaCors(res);
    const file = findFileByJellyfinId(store, req.params.id);
    await sendArtworkForFile(req, res, store, file, postersCacheDir);
  });

  app.head('/thumb/:token/:id', async (req, res) => {
    setMediaCors(res);
    res.setHeader('Content-Type', 'image/jpeg');
    res.status(200).end();
  });

  // Xtream Codes API: /get.php (M3U download) & /xmltv.php (EPG)
  app.all('/get.php', (req, res) => {
    setMediaCors(res);
    const username = String(req.query.username || req.body?.username || '');
    const password = String(req.query.password || req.body?.password || '');
    const token = resolveShareTokenFromXtream(username, password);
    if (!token) {
      res.status(401).json({ error: 'Ungültige Xtream-Zugangsdaten.' });
      return;
    }
    const files = getSharedFilesForToken(token);
    const m3u = buildM3UPlaylist(files, getOrigin(req), token);
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="AndreDrive-Videothek.m3u"');
    res.status(200).send(m3u);
  });

  app.all('/xmltv.php', (_req, res) => {
    setMediaCors(res);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res
      .status(200)
      .send('<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="AndreDrive"></tv>');
  });

  // Xtream Codes API: /player_api.php and /panel_api.php
  app.all(['/player_api.php', '/panel_api.php'], (req, res) => {
    setMediaCors(res);
    const origin = getOrigin(req);
    const parsedOrigin = new URL(origin);
    const username = String(req.query.username || req.body?.username || '').trim();
    const password = String(req.query.password || req.body?.password || '').trim();
    const action = String(req.query.action || req.body?.action || '')
      .trim()
      .toLowerCase();

    const token = resolveShareTokenFromXtream(username, password);
    const nowSec = Math.floor(Date.now() / 1000);
    const serverInfo = {
      url: parsedOrigin.hostname,
      port: parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? '443' : '80'),
      https_port: parsedOrigin.protocol === 'https:' ? parsedOrigin.port || '443' : '443',
      server_protocol: parsedOrigin.protocol.replace(':', ''),
      rtmp_port: '1935',
      timezone: 'Europe/Berlin',
      timestamp_now: nowSec,
      time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
      process: true,
    };

    if (!token) {
      res.status(200).json({
        user_info: {
          auth: 0,
          status: 'Disabled',
          message: 'Ungültige Zugangsdaten',
        },
        server_info: serverInfo,
      });
      return;
    }

    const userInfo = {
      username,
      password,
      message: 'AndreDrive VOD',
      auth: 1,
      status: 'Active',
      exp_date: String(nowSec + 365 * 86400),
      is_trial: '0',
      active_cons: '0',
      created_at: String(nowSec - 86400),
      max_connections: '10',
      allowed_output_formats: ['m3u8', 'ts', 'mp4'],
    };

    if (!action) {
      res.json({ user_info: userInfo, server_info: serverInfo });
      return;
    }

    const files = getSharedFilesForToken(token);
    const movies = files.filter((f) => !isSeriesEpisode(f));
    const seriesGroups = buildSeriesGroups(files);

    // Map each file to a deterministic numeric stream ID
    const streamIdMap = new Map<string, number>();
    const reverseStreamMap = new Map<number, AndreDriveFile>();
    files.forEach((f, idx) => {
      const idNum = 10000 + idx + 1;
      streamIdMap.set(f.id, idNum);
      reverseStreamMap.set(idNum, f);
    });

    if (action === 'get_live_categories' || action === 'get_live_streams') {
      res.json([]);
      return;
    }

    if (action === 'get_vod_categories') {
      res.json([
        {
          category_id: '1',
          category_name: 'Filme',
          parent_id: 0,
        },
      ]);
      return;
    }

    if (action === 'get_vod_streams') {
      const categoryFilter = String(req.query.category_id || '').trim();
      if (categoryFilter && categoryFilter !== '1' && categoryFilter !== '*') {
        res.json([]);
        return;
      }
      res.json(
        movies.map((f, i) => {
          const sid = streamIdMap.get(f.id) || 10001 + i;
          const cover = resolveAbsoluteArtworkUrl(f, origin, token);
          return {
            num: i + 1,
            name: f.metadata?.title || f.name.replace(/\.[^.]+$/, ''),
            title: f.metadata?.title || f.name.replace(/\.[^.]+$/, ''),
            year: f.metadata?.year || '',
            stream_type: 'movie',
            stream_id: sid,
            stream_icon: cover,
            rating: Number(f.metadata?.rating || 8.0),
            rating_5based: Number(((Number(f.metadata?.rating || 8.0) / 10) * 5).toFixed(1)),
            added: String(nowSec),
            category_id: '1',
            category_ids: [1],
            container_extension: fileContainer(f),
            custom_sid: '',
            direct_source: `${origin}/media/${token}/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`,
          };
        })
      );
      return;
    }

    if (action === 'get_vod_info') {
      const vodId = Number(req.query.vod_id || req.body?.vod_id || 0);
      const file = reverseStreamMap.get(vodId) || movies[0];
      if (!file) {
        res.json({ info: {}, movie_data: {} });
        return;
      }
      const sid = streamIdMap.get(file.id) || vodId || 10001;
      const cover = resolveAbsoluteArtworkUrl(file, origin, token);
      const durSec = Math.max(1, parseDurationToSeconds(file.duration, file.metadata?.runtime_minutes));
      res.json({
        info: {
          kinopoisk_url: '',
          tmdb_id: file.metadata?.tmdb_id || '',
          name: file.metadata?.title || file.name,
          o_name: file.metadata?.original_title || file.metadata?.title || file.name,
          cover_big: cover,
          movie_image: cover,
          releasedate: file.metadata?.year ? `${file.metadata.year}-01-01` : '',
          episode_run_time: String(Math.round(durSec / 60)),
          youtube_trailer: '',
          director: file.metadata?.director || '',
          actors: file.metadata?.cast || '',
          cast: file.metadata?.cast || '',
          description: file.metadata?.plot || '',
          plot: file.metadata?.plot || '',
          age: '',
          mpaa_rating: '',
          rating_count_kinopoisk: 0,
          country: file.metadata?.country || '',
          genre: file.metadata?.genres || 'Film',
          backdrop_path: cover ? [cover] : [],
          duration_secs: durSec,
          duration: file.duration || '49:00',
          video: {},
          audio: {},
          bitrate: 4000,
          rating: String(file.metadata?.rating || '8.0'),
        },
        movie_data: {
          stream_id: sid,
          name: file.metadata?.title || file.name,
          added: String(nowSec),
          category_id: '1',
          category_ids: [1],
          container_extension: fileContainer(file),
          custom_sid: '',
          direct_source: `${origin}/media/${token}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`,
        },
      });
      return;
    }

    if (action === 'get_series_categories') {
      res.json(
        seriesGroups.map((g, idx) => ({
          category_id: String(200 + idx + 1),
          category_name: `Serien - ${g.name}`,
          parent_id: 0,
        }))
      );
      return;
    }

    if (action === 'get_series') {
      const catFilter = String(req.query.category_id || '').trim();
      const list = seriesGroups
        .map((g, idx) => {
          const catId = String(200 + idx + 1);
          if (catFilter && catFilter !== '*' && catFilter !== catId) return null;
          const sid = 5000 + idx + 1;
          const f = g.primaryFile;
          const cover = resolveAbsoluteArtworkUrl(f, origin, token);
          return {
            num: idx + 1,
            name: g.name,
            title: g.name,
            year: f.metadata?.year || '1959',
            stream_type: 'series',
            series_id: sid,
            cover,
            plot: f.metadata?.plot || '',
            cast: f.metadata?.cast || '',
            director: f.metadata?.director || '',
            genre: f.metadata?.genres || 'Serie',
            releaseDate: f.metadata?.year ? `${f.metadata.year}-01-01` : '',
            release_date: f.metadata?.year ? `${f.metadata.year}-01-01` : '',
            last_modified: String(nowSec),
            rating: String(f.metadata?.rating || '8.3'),
            rating_5based: Number(((Number(f.metadata?.rating || 8.3) / 10) * 5).toFixed(1)),
            backdrop_path: cover ? [cover] : [],
            youtube_trailer: '',
            episode_run_time: String(f.metadata?.runtime_minutes || '49'),
            category_id: catId,
            category_ids: [Number(catId)],
          };
        })
        .filter(Boolean);
      res.json(list);
      return;
    }

    if (action === 'get_series_info') {
      const seriesIdNum = Number(req.query.series_id || req.body?.series_id || 5001);
      const groupIdx = Math.max(0, seriesIdNum - 5001);
      const group = seriesGroups[groupIdx] || seriesGroups[0];
      if (!group) {
        res.json({ seasons: [], info: {}, episodes: {} });
        return;
      }
      const f = group.primaryFile;
      const cover = resolveAbsoluteArtworkUrl(f, origin, token);
      const seasonsArr: any[] = [];
      const episodesBySeason: Record<string, any[]> = {};

      for (const [seasonNum, epList] of [...group.seasons.entries()].sort((a, b) => a[0] - b[0])) {
        seasonsArr.push({
          air_date: f.metadata?.year ? `${f.metadata.year}-01-01` : '1959-01-09',
          episode_count: epList.length,
          id: seasonNum,
          name: `Staffel ${seasonNum}`,
          overview: f.metadata?.plot || '',
          season_number: seasonNum,
          cover,
          cover_big: cover,
        });
        episodesBySeason[String(seasonNum)] = epList.map((ep) => {
          const sid = streamIdMap.get(ep.id) || 10001;
          const epNum = Number(ep.episode) || 1;
          const epTitle = ep.metadata?.episode_title || `Episode ${epNum}`;
          const epCover = resolveAbsoluteArtworkUrl(ep, origin, token) || cover;
          const durSec = Math.max(1, parseDurationToSeconds(ep.duration, ep.metadata?.runtime_minutes));
          return {
            id: String(sid),
            episode_num: epNum,
            title: `${group.name} - S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')} - ${epTitle}`,
            container_extension: fileContainer(ep),
            info: {
              tmdb_id: ep.metadata?.tmdb_id || '',
              releasedate: ep.metadata?.year ? `${ep.metadata.year}-01-01` : '',
              plot: ep.metadata?.plot || '',
              duration_secs: durSec,
              duration: ep.duration || '48:37',
              movie_image: epCover,
              bitrate: 4000,
              rating: Number(ep.metadata?.rating || 8.3),
              season: String(seasonNum),
            },
            custom_sid: '',
            added: String(nowSec),
            season: seasonNum,
            direct_source: `${origin}/media/${token}/${encodeURIComponent(ep.id)}/${encodeURIComponent(ep.name)}`,
          };
        });
      }

      res.json({
        seasons: seasonsArr,
        info: {
          name: group.name,
          title: group.name,
          year: f.metadata?.year || '1959',
          cover,
          plot: f.metadata?.plot || '',
          cast: f.metadata?.cast || '',
          director: f.metadata?.director || '',
          genre: f.metadata?.genres || 'Serie',
          releaseDate: f.metadata?.year ? `${f.metadata.year}-01-01` : '',
          last_modified: String(nowSec),
          rating: String(f.metadata?.rating || '8.3'),
          rating_5based: Number(((Number(f.metadata?.rating || 8.3) / 10) * 5).toFixed(1)),
          backdrop_path: cover ? [cover] : [],
          youtube_trailer: '',
          episode_run_time: String(f.metadata?.runtime_minutes || '49'),
          category_id: String(200 + groupIdx + 1),
          category_ids: [200 + groupIdx + 1],
        },
        episodes: episodesBySeason,
      });
      return;
    }

    res.json([]);
  });

  // Xtream movie & series stream URLs: /movie/:username/:password/:target and /series/:username/:password/:target
  app.all(['/movie/:username/:password/:target', '/series/:username/:password/:target'], async (req, res) => {
    setMediaCors(res);
    const token = resolveShareTokenFromXtream(req.params.username, req.params.password);
    if (!token) {
      res.status(401).json({ error: 'Ungültige Xtream-Zugangsdaten.' });
      return;
    }
    const rawTarget = String(req.params.target || '').replace(/\.[a-z0-9]{2,5}$/i, '');
    const files = getSharedFilesForToken(token);
    const numericId = Number(rawTarget);
    let targetFile = files.find((f) => f.id === rawTarget);
    if (!targetFile && Number.isFinite(numericId) && numericId >= 10001) {
      targetFile = files[numericId - 10001];
    }
    if (!targetFile) {
      targetFile = files[0];
    }
    if (!targetFile) {
      res.status(404).json({ error: 'Stream nicht gefunden.' });
      return;
    }
    await serveFileContent(req, res, targetFile.id);
  });

  // ============================================================================
  // 2. JELLYFIN / MOONFIN SERVER PROTOCOL
  // ============================================================================

  const handleJellyfinRequest = async (req: express.Request, res: express.Response): Promise<boolean> => {
    setJellyfinCors(res);
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return true;
    }

    // Normalize path by stripping optional /jellyfin or /emby prefix
    const rawPath = req.path.replace(/^\/(?:jellyfin|emby)(?=\/|$)/i, '') || '/';
    const cleanPath = rawPath.replace(/\/+$/, '') || '/';
    const lowerPath = cleanPath.toLowerCase();
    const origin = getOrigin(req);

    // Public discovery endpoints (No Auth Required)
    if (lowerPath === '' || lowerPath === '/' || lowerPath === '/system/info/public') {
      res.json({
        LocalAddress: `${origin}/jellyfin`,
        ServerName: JELLYFIN_SERVER_NAME,
        Version: JELLYFIN_VERSION,
        ProductName: 'Jellyfin Server',
        OperatingSystem: 'Linux',
        Id: JELLYFIN_SERVER_ID,
        StartupWizardCompleted: true,
      });
      return true;
    }

    if (lowerPath === '/system/ping') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(JELLYFIN_SERVER_NAME);
      return true;
    }

    if (lowerPath === '/users/public') {
      // Return empty array so Moonfin / Jellyfin clients show the manual username + password login form
      res.json([]);
      return true;
    }

    if (lowerPath === '/branding/configuration') {
      res.json({
        LoginDisclaimer: 'Melde dich mit deinem AndreDrive Jellyfin-Gerätezugang an.',
        CustomCss: '',
        SplashscreenEnabled: false,
      });
      return true;
    }

    if (lowerPath === '/branding/css' || lowerPath === '/branding/css.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.status(200).send('');
      return true;
    }

    if (lowerPath === '/quickconnect/enabled') {
      res.json(false);
      return true;
    }

    if (lowerPath === '/system/endpoint') {
      res.json({ IsLocal: false, IsInNetwork: true });
      return true;
    }

    // Authentication endpoint: POST /Users/AuthenticateByName
    if (lowerPath === '/users/authenticatebyname' && req.method === 'POST') {
      const body = req.body || {};
      const username = String(body.Username ?? body.username ?? '').trim();
      const password = String(body.Pw ?? body.Password ?? body.pw ?? body.password ?? '').trim();
      if (!username || !password) {
        res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
        return true;
      }

      const matchedAccount = store.jellyfinAccounts.find(
        (acc) => acc.username.toLowerCase() === username.toLowerCase() && acc.password === password
      );

      if (!matchedAccount) {
        res.status(401).json({ error: 'Ungültiger Jellyfin-Benutzername oder Passwort.' });
        return true;
      }

      matchedAccount.last_used = new Date().toISOString();
      const authMeta = parseEmbyAuthHeader(req);
      const token = crypto.randomBytes(24).toString('hex');
      const userId = jellyHexId(`user:${store.user.id}`);
      const sessionId = jellyHexId(`session:${token}`);

      store.jellyfinSessions[token] = {
        token,
        accountId: matchedAccount.id,
        userId,
        username: matchedAccount.username,
        deviceId: authMeta.deviceId,
        client: authMeta.client,
        deviceName: authMeta.device,
        version: authMeta.version,
        created: new Date().toISOString(),
      };
      store.saveToDisk();

      const userDto = buildUserDto(userId, matchedAccount.username);
      res.json({
        User: userDto,
        SessionInfo: {
          PlayState: {
            CanSeek: true,
            IsPaused: false,
            IsMuted: false,
            RepeatMode: 'RepeatNone',
          },
          AdditionalUsers: [],
          Capabilities: {
            PlayableMediaTypes: ['Video', 'Audio'],
            SupportedCommands: [],
            SupportsMediaControl: true,
            SupportsPersistentIdentifier: true,
          },
          RemoteEndPoint: '0.0.0.0',
          PlayableMediaTypes: ['Video', 'Audio'],
          Id: sessionId,
          UserId: userId,
          UserName: matchedAccount.username,
          Client: authMeta.client,
          LastActivityDate: new Date().toISOString(),
          LastPlaybackCheckIn: new Date().toISOString(),
          DeviceName: authMeta.device,
          DeviceId: authMeta.deviceId,
          ApplicationVersion: authMeta.version,
          IsActive: true,
          SupportsMediaControl: false,
          SupportsRemoteControl: false,
          NowPlayingQueue: [],
          NowPlayingQueueFullItems: [],
          HasCustomDeviceName: false,
          ServerId: JELLYFIN_SERVER_ID,
          SupportedCommands: [],
        },
        AccessToken: token,
        ServerId: JELLYFIN_SERVER_ID,
      });
      return true;
    }

    // Artwork routes can be requested by Jellyfin/Moonfin img tags with or without token headers
    const imageMatch = /^\/items\/([^/]+)\/images\/([^/]+)(?:\/[^/]+)?$/i.exec(cleanPath);
    if (imageMatch) {
      const rawItemId = decodeURIComponent(imageMatch[1]);
      const normItemId = normalizeJellyId(rawItemId);
      const videoFiles = getVideoFiles(store);
      const seriesGroups = buildSeriesGroups(videoFiles);

      let targetFile = findFileByJellyfinId(store, rawItemId);
      if (!targetFile) {
        const seriesGroup = seriesGroups.find((g) => g.id === normItemId);
        if (seriesGroup) {
          targetFile = seriesGroup.primaryFile;
        } else {
          for (const g of seriesGroups) {
            for (const [seasonNum, eps] of g.seasons.entries()) {
              if (seasonIdFor(g.key, seasonNum) === normItemId) {
                targetFile = eps[0] || g.primaryFile;
                break;
              }
            }
          }
        }
      }
      await sendArtworkForFile(req, res, store, targetFile, postersCacheDir);
      return true;
    }

    // Video stream routes (Moonfin / ExoPlayer / VLC / MPV direct play)
    const videoStreamMatch =
      /^\/videos\/([^/]+)\/(?:stream(?:\.[a-z0-9]+)?|original|main\.m3u8|master\.m3u8)$/i.exec(
        cleanPath
      ) || /^\/items\/([^/]+)\/download$/i.exec(cleanPath);
    if (videoStreamMatch) {
      const rawItemId = decodeURIComponent(videoStreamMatch[1]);
      const file = findFileByJellyfinId(store, rawItemId);
      if (!file) {
        res.status(404).json({ error: 'Medium nicht gefunden.' });
        return true;
      }
      if (/\.m3u8$/i.test(cleanPath)) {
        const itemHex = jellyHexId(`file:${file.id}`);
        const ext = fileContainer(file);
        const tokenParam = req.query.api_key ? `?api_key=${encodeURIComponent(String(req.query.api_key))}` : '';
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.status(200).send(
          `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n${origin}/jellyfin/Videos/${itemHex}/stream.${ext}${tokenParam}\n`
        );
        return true;
      }
      await serveFileContent(req, res, file.id);
      return true;
    }

    // Authenticate session token (or fallback to active user if session was created before)
    const authMeta = parseEmbyAuthHeader(req);
    const session = authMeta.token ? store.jellyfinSessions[authMeta.token] : undefined;
    const defaultUserId = jellyHexId(`user:${store.user.id}`);
    const activeUserId = session?.userId || defaultUserId;
    const activeUsername =
      session?.username ||
      store.jellyfinAccounts[0]?.username ||
      store.user.name ||
      'Andre';

    // Require a valid session or configured Jellyfin account for protected routes
    if (!session && authMeta.token) {
      // Allow token if any Jellyfin account exists (for seamless Moonfin reconnects across server restarts)
      const fallbackAcc = store.jellyfinAccounts[0];
      if (fallbackAcc) {
        store.jellyfinSessions[authMeta.token] = {
          token: authMeta.token,
          accountId: fallbackAcc.id,
          userId: defaultUserId,
          username: fallbackAcc.username,
          deviceId: authMeta.deviceId,
          client: authMeta.client,
          deviceName: authMeta.device,
          version: authMeta.version,
          created: new Date().toISOString(),
        };
        store.saveToDisk();
      }
    }

    if (lowerPath === '/system/info') {
      res.json({
        LocalAddress: `${origin}/jellyfin`,
        ServerName: JELLYFIN_SERVER_NAME,
        Version: JELLYFIN_VERSION,
        ProductName: 'Jellyfin Server',
        OperatingSystem: 'Linux',
        Id: JELLYFIN_SERVER_ID,
        StartupWizardCompleted: true,
        CanSelfRestart: false,
        CanLaunchWebBrowser: false,
        HasPendingRestart: false,
        IsShuttingDown: false,
        SupportsLibraryMonitor: true,
        WebSocketPortNumber: 443,
        CompletedInstallations: [],
      });
      return true;
    }

    if (lowerPath === '/users/me' || lowerPath === `/users/${activeUserId.toLowerCase()}`) {
      res.json(buildUserDto(activeUserId, activeUsername));
      return true;
    }

    if (lowerPath === '/users') {
      res.json([buildUserDto(activeUserId, activeUsername)]);
      return true;
    }

    if (/^\/displaypreferences\//i.test(cleanPath)) {
      if (req.method === 'POST') {
        res.status(204).end();
        return true;
      }
      res.json({
        Id: 'usersettings',
        SortBy: 'SortName',
        RememberIndexing: false,
        PrimaryImageHeight: 250,
        PrimaryImageWidth: 250,
        CustomPrefs: {},
        ScrollDirection: 'Horizontal',
        ShowBackdrop: true,
        RememberSorting: false,
        SortOrder: 'Ascending',
        ShowSidebar: false,
        Client: String(req.query.client || 'emby'),
      });
      return true;
    }

    if (lowerPath === '/sessions') {
      res.json([]);
      return true;
    }

    if (lowerPath === '/sessions/capabilities' || lowerPath === '/sessions/capabilities/full') {
      res.status(204).end();
      return true;
    }

    if (lowerPath === '/sessions/playing/ping') {
      res.status(204).end();
      return true;
    }

    if (
      lowerPath === '/sessions/playing' ||
      lowerPath === '/sessions/playing/progress' ||
      lowerPath === '/sessions/playing/stopped'
    ) {
      const body = req.body || {};
      const itemId = normalizeJellyId(body.ItemId || body.itemId);
      const posTicks = Math.max(0, Number(body.PositionTicks ?? body.positionTicks ?? 0) || 0);
      if (itemId) {
        const prev = store.jellyfinUserState[itemId] || {
          played: false,
          playCount: 0,
          positionTicks: 0,
          favorite: false,
        };
        const isStopped = lowerPath.endsWith('/stopped');
        store.jellyfinUserState[itemId] = {
          ...prev,
          positionTicks: posTicks,
          played: prev.played || (isStopped && posTicks > 0),
          playCount: isStopped ? prev.playCount + 1 : prev.playCount,
          lastPlayed: new Date().toISOString(),
        };
        store.saveToDisk();
      }
      res.status(204).end();
      return true;
    }

    // Favorite / Played item toggles
    const favMatch =
      /^\/users\/[^/]+\/favoriteitems\/([^/]+)$/i.exec(cleanPath) ||
      /^\/userfavoriteitems\/([^/]+)$/i.exec(cleanPath);
    if (favMatch) {
      const itemId = normalizeJellyId(decodeURIComponent(favMatch[1]));
      const prev = store.jellyfinUserState[itemId] || {
        played: false,
        playCount: 0,
        positionTicks: 0,
        favorite: false,
      };
      store.jellyfinUserState[itemId] = {
        ...prev,
        favorite: req.method !== 'DELETE',
      };
      store.saveToDisk();
      res.json(userDataDto(store, itemId));
      return true;
    }

    const playedMatch =
      /^\/users\/[^/]+\/playeditems\/([^/]+)$/i.exec(cleanPath) ||
      /^\/userplayeditems\/([^/]+)$/i.exec(cleanPath);
    if (playedMatch) {
      const itemId = normalizeJellyId(decodeURIComponent(playedMatch[1]));
      const prev = store.jellyfinUserState[itemId] || {
        played: false,
        playCount: 0,
        positionTicks: 0,
        favorite: false,
      };
      const played = req.method !== 'DELETE';
      store.jellyfinUserState[itemId] = {
        ...prev,
        played,
        playCount: played ? Math.max(1, prev.playCount + 1) : prev.playCount,
        positionTicks: played ? 0 : prev.positionTicks,
        lastPlayed: new Date().toISOString(),
      };
      store.saveToDisk();
      res.json(userDataDto(store, itemId));
      return true;
    }

    // Build full catalog items for library queries
    const videoFiles = getVideoFiles(store);
    const movies = videoFiles.filter((f) => !isSeriesEpisode(f));
    const seriesGroups = buildSeriesGroups(videoFiles);
    const movieDtos = movies.map((f) => buildMovieDto(store, f));
    const seriesDtos = seriesGroups.map((g) => buildSeriesDto(store, g));
    const seasonDtos: any[] = [];
    const episodeDtos: any[] = [];
    for (const group of seriesGroups) {
      for (const [seasonNum, eps] of [...group.seasons.entries()].sort((a, b) => a[0] - b[0])) {
        seasonDtos.push(buildSeasonDto(store, group, seasonNum, eps));
        for (const ep of eps) {
          episodeDtos.push(buildEpisodeDto(store, group, ep));
        }
      }
    }

    const allDtosById = new Map<string, any>();
    const views = [
      buildViewDto(VIEW_MOVIES_ID, 'Filme', 'movies', movieDtos.length),
      buildViewDto(VIEW_SERIES_ID, 'Serien', 'tvshows', seriesDtos.length),
    ];
    for (const item of [...views, ...movieDtos, ...seriesDtos, ...seasonDtos, ...episodeDtos]) {
      allDtosById.set(item.Id, item);
    }

    // User Views (/UserViews and /Users/:id/Views)
    if (lowerPath === '/userviews' || /^\/users\/[^/]+\/views$/i.test(cleanPath)) {
      res.json({
        Items: views,
        TotalRecordCount: views.length,
        StartIndex: 0,
      });
      return true;
    }

    if (lowerPath === '/library/mediafolders') {
      res.json({
        Items: views,
        TotalRecordCount: views.length,
        StartIndex: 0,
      });
      return true;
    }

    // Latest Items (/Items/Latest and /Users/:id/Items/Latest)
    if (lowerPath === '/items/latest' || /^\/users\/[^/]+\/items\/latest$/i.test(cleanPath)) {
      const parentId = normalizeJellyId(String(req.query.parentId || req.query.ParentId || ''));
      const limit = Math.max(1, Math.min(100, Number(req.query.limit || req.query.Limit || 20)));
      let pool =
        parentId === VIEW_MOVIES_ID
          ? movieDtos
          : parentId === VIEW_SERIES_ID
          ? seriesDtos.length > 0
            ? seriesDtos
            : episodeDtos
          : [...movieDtos, ...seriesDtos, ...episodeDtos];
      res.json(pool.slice(0, limit));
      return true;
    }

    // Resume Items (/UserItems/Resume and /Users/:id/Items/Resume)
    if (lowerPath === '/useritems/resume' || /^\/users\/[^/]+\/items\/resume$/i.test(cleanPath)) {
      const resumable = [...movieDtos, ...episodeDtos].filter(
        (item) => (item.UserData?.PlaybackPositionTicks || 0) > 0 && !item.UserData?.Played
      );
      res.json({
        Items: resumable,
        TotalRecordCount: resumable.length,
        StartIndex: 0,
      });
      return true;
    }

    // Shows/NextUp
    if (lowerPath === '/shows/nextup') {
      const seriesFilter = normalizeJellyId(String(req.query.seriesId || req.query.SeriesId || ''));
      const candidates = episodeDtos.filter(
        (ep) => (!seriesFilter || ep.SeriesId === seriesFilter) && !ep.UserData?.Played
      );
      res.json({
        Items: candidates.slice(0, 20),
        TotalRecordCount: candidates.length,
        StartIndex: 0,
      });
      return true;
    }

    // Shows/:id/Seasons
    const seasonsMatch = /^\/shows\/([^/]+)\/seasons$/i.exec(cleanPath);
    if (seasonsMatch) {
      const seriesId = normalizeJellyId(decodeURIComponent(seasonsMatch[1]));
      const items = seasonDtos.filter((s) => s.SeriesId === seriesId);
      res.json({
        Items: items,
        TotalRecordCount: items.length,
        StartIndex: 0,
      });
      return true;
    }

    // Shows/:id/Episodes
    const episodesMatch = /^\/shows\/([^/]+)\/episodes$/i.exec(cleanPath);
    if (episodesMatch) {
      const seriesId = normalizeJellyId(decodeURIComponent(episodesMatch[1]));
      const seasonId = normalizeJellyId(String(req.query.seasonId || req.query.SeasonId || ''));
      const seasonNum = Number(req.query.season ?? req.query.Season ?? NaN);
      let items = episodeDtos.filter((ep) => ep.SeriesId === seriesId);
      if (seasonId) items = items.filter((ep) => ep.SeasonId === seasonId);
      if (Number.isFinite(seasonNum)) {
        items = items.filter((ep) => ep.ParentIndexNumber === seasonNum);
      }
      res.json({
        Items: items,
        TotalRecordCount: items.length,
        StartIndex: 0,
      });
      return true;
    }

    // PlaybackInfo (/Items/:id/PlaybackInfo)
    const playbackMatch = /^\/items\/([^/]+)\/playbackinfo$/i.exec(cleanPath);
    if (playbackMatch) {
      const rawId = decodeURIComponent(playbackMatch[1]);
      const file = findFileByJellyfinId(store, rawId);
      if (!file) {
        res.status(404).json({ error: 'Medium nicht gefunden.' });
        return true;
      }
      const itemHex = jellyHexId(`file:${file.id}`);
      res.json({
        MediaSources: [mediaSourceForFile(file, itemHex)],
        PlaySessionId: jellyHexId(`playsession:${file.id}:${Date.now()}`),
      });
      return true;
    }

    // Similar / SpecialFeatures / Trailers / LocalTrailers / ThemeMedia / Intros
    if (/^\/items\/[^/]+\/(?:similar|trailers|localtrailers|specialfeatures)$/i.test(cleanPath)) {
      if (lowerPath.endsWith('/similar')) {
        res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      } else {
        res.json([]);
      }
      return true;
    }

    if (/^\/items\/[^/]+\/thememedia$/i.test(cleanPath)) {
      res.json({
        ThemeVideosResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
        ThemeSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
        SoundtrackSongsResult: { Items: [], TotalRecordCount: 0, StartIndex: 0 },
      });
      return true;
    }

    if (/^\/users\/[^/]+\/items\/[^/]+\/intros$/i.test(cleanPath)) {
      res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      return true;
    }

    // Single Item detail (/Items/:id and /Users/:userId/Items/:id)
    const singleItemMatch =
      /^\/users\/[^/]+\/items\/([^/]+)$/i.exec(cleanPath) ||
      /^\/items\/([^/]+)$/i.exec(cleanPath);
    if (
      singleItemMatch &&
      !['filters', 'filters2', 'counts', 'latest', 'resume', 'suggestions'].includes(
        singleItemMatch[1].toLowerCase()
      )
    ) {
      const rawId = decodeURIComponent(singleItemMatch[1]);
      const normId = normalizeJellyId(rawId);
      let dto = allDtosById.get(normId);
      if (!dto) {
        const file = findFileByJellyfinId(store, rawId);
        if (file) {
          dto = allDtosById.get(jellyHexId(`file:${file.id}`));
        }
      }
      if (!dto) {
        res.status(404).json({ error: 'Eintrag nicht gefunden.' });
        return true;
      }
      res.json(dto);
      return true;
    }

    // Item Filters & Counts
    if (lowerPath === '/items/filters' || lowerPath === '/items/filters2') {
      const genres = new Set<string>();
      const years = new Set<number>();
      for (const item of [...movieDtos, ...seriesDtos]) {
        for (const g of item.Genres || []) genres.add(g);
        if (item.ProductionYear) years.add(item.ProductionYear);
      }
      res.json({
        Genres: [...genres].sort(),
        Tags: [],
        OfficialRatings: [],
        Years: [...years].sort((a, b) => b - a),
      });
      return true;
    }

    if (lowerPath === '/items/counts') {
      res.json({
        MovieCount: movieDtos.length,
        SeriesCount: seriesDtos.length,
        EpisodeCount: episodeDtos.length,
        ArtistCount: 0,
        ProgramCount: 0,
        TrailerCount: 0,
        SongCount: 0,
        AlbumCount: 0,
        MusicVideoCount: 0,
        BoxSetCount: 0,
        BookCount: 0,
        ItemCount: movieDtos.length + seriesDtos.length + episodeDtos.length,
      });
      return true;
    }

    // Genres, Persons, Studios, Search
    if (lowerPath === '/genres' || lowerPath === '/persons' || lowerPath === '/studios') {
      res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      return true;
    }

    if (lowerPath === '/search/hints') {
      const term = String(req.query.searchTerm || req.query.SearchTerm || '')
        .trim()
        .toLowerCase();
      const hits = [...movieDtos, ...seriesDtos, ...episodeDtos]
        .filter((item) => !term || String(item.Name || '').toLowerCase().includes(term))
        .slice(0, 25)
        .map((item) => ({
          ItemId: item.Id,
          Id: item.Id,
          Name: item.Name,
          ProductionYear: item.ProductionYear,
          IndexNumber: item.IndexNumber,
          ParentIndexNumber: item.ParentIndexNumber,
          PrimaryImageTag: item.ImageTags?.Primary,
          Type: item.Type,
          IsFolder: Boolean(item.IsFolder),
          RunTimeTicks: item.RunTimeTicks,
          MediaType: item.MediaType || 'Video',
          Series: item.SeriesName,
        }));
      res.json({ SearchHints: hits, TotalRecordCount: hits.length });
      return true;
    }

    // Main Items Query (/Items and /Users/:id/Items)
    if (lowerPath === '/items' || /^\/users\/[^/]+\/items$/i.test(cleanPath)) {
      const parentId = normalizeJellyId(String(req.query.parentId || req.query.ParentId || ''));
      const seriesId = normalizeJellyId(String(req.query.seriesId || req.query.SeriesId || ''));
      const includeTypes = splitList(req.query.includeItemTypes || req.query.IncludeItemTypes).map(
        (t) => t.toLowerCase()
      );
      const excludeTypes = splitList(req.query.excludeItemTypes || req.query.ExcludeItemTypes).map(
        (t) => t.toLowerCase()
      );
      const idsFilter = splitList(req.query.ids || req.query.Ids).map(normalizeJellyId);
      const recursive =
        String(req.query.recursive ?? req.query.Recursive ?? '').toLowerCase() === 'true';
      const searchTerm = String(req.query.searchTerm || req.query.SearchTerm || '')
        .trim()
        .toLowerCase();

      let items: any[] = [];
      if (idsFilter.length > 0) {
        items = idsFilter.map((id) => allDtosById.get(id)).filter(Boolean);
      } else if (parentId === VIEW_MOVIES_ID) {
        items = [...movieDtos];
      } else if (parentId === VIEW_SERIES_ID) {
        if (
          recursive &&
          includeTypes.length > 0 &&
          !includeTypes.includes('series')
        ) {
          items = [...seasonDtos, ...episodeDtos];
        } else {
          items = [...seriesDtos];
        }
      } else if (parentId) {
        const parentSeries = seriesGroups.find((g) => g.id === parentId);
        if (parentSeries) {
          items = recursive
            ? episodeDtos.filter((ep) => ep.SeriesId === parentSeries.id)
            : seasonDtos.filter((s) => s.SeriesId === parentSeries.id);
        } else {
          items = episodeDtos.filter((ep) => ep.SeasonId === parentId);
        }
      } else if (seriesId) {
        items = episodeDtos.filter((ep) => ep.SeriesId === seriesId);
      } else if (recursive || includeTypes.length > 0 || searchTerm) {
        items = [...movieDtos, ...seriesDtos, ...seasonDtos, ...episodeDtos];
      } else {
        items = [...views];
      }

      if (includeTypes.length > 0) {
        items = items.filter((item) =>
          includeTypes.includes(String(item.Type || '').toLowerCase())
        );
      }
      if (excludeTypes.length > 0) {
        items = items.filter(
          (item) => !excludeTypes.includes(String(item.Type || '').toLowerCase())
        );
      }
      if (searchTerm) {
        items = items.filter(
          (item) =>
            String(item.Name || '').toLowerCase().includes(searchTerm) ||
            String(item.SeriesName || '').toLowerCase().includes(searchTerm) ||
            String(item.Overview || '').toLowerCase().includes(searchTerm)
        );
      }

      const startIndex = Math.max(0, Number(req.query.startIndex || req.query.StartIndex || 0));
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || req.query.Limit || 200)));
      const paged = items.slice(startIndex, startIndex + limit);

      res.json({
        Items: paged,
        TotalRecordCount: items.length,
        StartIndex: startIndex,
      });
      return true;
    }

    if (/^\/localization\//i.test(cleanPath)) {
      res.json([]);
      return true;
    }

    if (req.path.toLowerCase().startsWith('/jellyfin') || req.path.toLowerCase().startsWith('/emby')) {
      res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
      return true;
    }

    return false;
  };

  // Mount Jellyfin handler on /jellyfin/* and root Jellyfin API prefixes
  const jellyfinPrefixes = [
    '/jellyfin',
    '/emby',
    '/System',
    '/Users',
    '/Items',
    '/Videos',
    '/Shows',
    '/Sessions',
    '/UserViews',
    '/UserItems',
    '/UserFavoriteItems',
    '/UserPlayedItems',
    '/DisplayPreferences',
    '/Branding',
    '/QuickConnect',
    '/Search',
    '/Library',
    '/Genres',
    '/Persons',
    '/Studios',
    '/Localization',
  ];

  for (const prefix of jellyfinPrefixes) {
    app.use(prefix, async (req, res, next) => {
      try {
        const handled = await handleJellyfinRequest(req, res);
        if (!handled) next();
      } catch (err) {
        next(err);
      }
    });
  }

  // ============================================================================
  // 3. WEBDAV & ROMM SERVER PROTOCOL (/webdav/* and /romm-library/*)
  // ============================================================================

  const xmlEsc = (s: unknown): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  app.use(['/webdav', '/romm-library'], async (req, res) => {
    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    res.setHeader(
      'Allow',
      'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK'
    );
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY, PROPFIND, PROPPATCH, LOCK, UNLOCK'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Depth, Destination, Overwrite, Content-Type, Range, If-Range'
    );

    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }

    // Authenticate Basic Auth against webdavAccounts or rommSettings
    const authHeader = req.get('Authorization') || '';
    let authenticated = false;
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      const davMatch = store.webdavAccounts.find(
        (acc) => acc.username.toLowerCase() === user.toLowerCase() && acc.password === pass
      );
      const rommMatch =
        store.rommSettings.username &&
        store.rommSettings.username.toLowerCase() === user.toLowerCase();
      if (davMatch || rommMatch) {
        if (davMatch) davMatch.last_used = new Date().toISOString();
        authenticated = true;
      }
    }

    if (!authenticated && store.webdavAccounts.length > 0) {
      res.setHeader('WWW-Authenticate', 'Basic realm="AndreDrive WebDAV"');
      res.status(401).send('WebDAV Authentifizierung erforderlich');
      return;
    }

    const baseMount = req.baseUrl || '/webdav';
    const subPath = decodeURIComponent(req.path || '/').replace(/^\/+|\/+$/g, '');
    const segments = subPath ? subPath.split('/').filter(Boolean) : [];
    const isRommMount = baseMount === '/romm-library' || segments[0] === 'romm';
    const effectiveSegments =
      segments[0] === 'romm' ? segments.slice(1) : segments;

    if (req.method === 'PROPFIND') {
      const depth = String(req.get('Depth') || '1');
      const responses: string[] = [];

      const renderCollection = (href: string, name: string) => `
  <D:response>
    <D:href>${xmlEsc(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${xmlEsc(name)}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;

      const renderFile = (href: string, f: AndreDriveFile) => `
  <D:response>
    <D:href>${xmlEsc(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${xmlEsc(f.name)}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${Number(f.size || 0)}</D:getcontentlength>
        <D:getcontenttype>${xmlEsc(f.mime || 'application/octet-stream')}</D:getcontenttype>
        <D:getlastmodified>${new Date(f.created || Date.now()).toUTCString()}</D:getlastmodified>
        <D:getetag>"${xmlEsc(f.id)}"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;

      const currentHref = `${baseMount}/${subPath ? `${subPath}/` : ''}`;
      responses.push(renderCollection(currentHref, effectiveSegments.at(-1) || 'AndreDrive'));

      if (depth !== '0') {
        if (effectiveSegments.length === 0) {
          for (const fld of store.folders.filter((f) => !f.parent)) {
            responses.push(
              renderCollection(`${ currentHref }${encodeURIComponent(fld.name)}/`, fld.name)
            );
          }
          const rootFiles = isRommMount
            ? store.files
            : store.files.filter((f) => !f.folder || !store.folders.some((fl) => fl.id === f.folder));
          for (const f of rootFiles) {
            responses.push(renderFile(`${currentHref}${encodeURIComponent(f.name)}`, f));
          }
        } else {
          const folderName = effectiveSegments[0];
          const matchedFolder = store.folders.find(
            (fl) => fl.name.toLowerCase() === folderName.toLowerCase()
          );
          const folderFiles = matchedFolder
            ? store.files.filter((f) => f.folder === matchedFolder.id)
            : store.files.filter((f) => f.name.toLowerCase() === folderName.toLowerCase());
          for (const f of folderFiles) {
            responses.push(renderFile(`${currentHref}${encodeURIComponent(f.name)}`, f));
          }
        }
      }

      const xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}\n</D:multistatus>`;
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.status(207).send(xml);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const targetName = effectiveSegments.at(-1) || '';
      const file = store.files.find(
        (f) => f.name.toLowerCase() === targetName.toLowerCase() || f.id === targetName
      );
      if (!file) {
        res.status(404).send('Datei nicht gefunden');
        return;
      }
      await serveFileContent(req, res, file.id);
      return;
    }

    if (req.method === 'MKCOL') {
      const folderName = effectiveSegments.at(-1) || 'Neuer Ordner';
      store.createFolder(folderName, null);
      res.status(201).end();
      return;
    }

    res.status(204).end();
  });

  // ============================================================================
  // 4. SUBSONIC / NAVIDROME SERVER PROTOCOL (/rest/* and /subsonic/rest/*)
  // ============================================================================

  app.use(['/subsonic/rest', '/rest'], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const action = req.path.replace(/^\/+/, '').replace(/\.view$/i, '');
    const format = String(req.query.f || 'json').toLowerCase();

    const audioFiles = store.files.filter(
      (f) =>
        !f.deleted &&
        (f.kind === 'music' ||
          f.kind === 'audiobook' ||
          f.kind === 'podcast' ||
          (f.mime || '').startsWith('audio/'))
    );

    if (action === 'stream' || action === 'download') {
      const id = String(req.query.id || '').trim();
      const target = store.files.find((f) => f.id === id) || audioFiles[0] || store.files[0];
      if (!target) {
        res.status(404).end();
        return;
      }
      await serveFileContent(req, res, target.id);
      return;
    }

    if (action === 'getCoverArt') {
      const id = String(req.query.id || '').replace(/^(?:al-|ar-)/, '');
      const target = store.files.find((f) => f.id === id) || store.files[0];
      await sendArtworkForFile(req, res, store, target, postersCacheDir);
      return;
    }

    const sendSubsonic = (payload: Record<string, any>) => {
      const body = {
        'subsonic-response': {
          status: 'ok',
          version: '1.16.1',
          type: 'AndreDrive-Subsonic',
          serverVersion: '1.0.0',
          openSubsonic: true,
          ...payload,
        },
      };
      if (format === 'json' || format === 'jsonp') {
        res.json(body);
      } else {
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(
          `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1"/>`
        );
      }
    };

    const songs = audioFiles.map((f, idx) => ({
      id: f.id,
      parent: 'al-default',
      isDir: false,
      title: f.metadata?.title || f.name.replace(/\.[^.]+$/, ''),
      album: f.series || 'AndreDrive Musik',
      artist: f.metadata?.author || f.metadata?.director || 'AndreDrive',
      track: idx + 1,
      year: Number(f.metadata?.year) || 2026,
      genre: f.metadata?.genres || 'Audio',
      coverArt: f.id,
      size: f.size,
      contentType: f.mime || 'audio/mpeg',
      suffix: fileContainer(f),
      duration: Math.max(1, parseDurationToSeconds(f.duration, f.metadata?.runtime_minutes)),
      bitRate: 320,
      path: f.name,
      isVideo: false,
      created: f.created,
      albumId: 'al-default',
      artistId: 'ar-default',
      type: 'music',
    }));

    if (action === 'getMusicFolders') {
      sendSubsonic({ musicFolders: { musicFolder: [{ id: 1, name: 'AndreDrive Musik' }] } });
      return;
    }
    if (action === 'getAlbumList' || action === 'getAlbumList2') {
      sendSubsonic({
        [action === 'getAlbumList2' ? 'albumList2' : 'albumList']: {
          album: songs.length
            ? [
                {
                  id: 'al-default',
                  name: 'AndreDrive Audio',
                  title: 'AndreDrive Audio',
                  artist: 'AndreDrive',
                  artistId: 'ar-default',
                  coverArt: songs[0].id,
                  songCount: songs.length,
                  duration: songs.reduce((a, s) => a + s.duration, 0),
                  created: new Date().toISOString(),
                },
              ]
            : [],
        },
      });
      return;
    }
    if (action === 'getRandomSongs') {
      sendSubsonic({ randomSongs: { song: songs } });
      return;
    }
    if (action === 'search2' || action === 'search3') {
      sendSubsonic({
        [action === 'search3' ? 'searchResult3' : 'searchResult2']: {
          artist: [],
          album: [],
          song: songs,
        },
      });
      return;
    }
    sendSubsonic({});
  });

  // ============================================================================
  // 5. OPDS 1.2 / 2.0 & OPDSHELF SERVER PROTOCOL (/opds/* and /opdshelf/*)
  // ============================================================================

  app.use(['/opds', '/opdshelf'], async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const origin = getOrigin(req);
    const books = store.files.filter(
      (f) => !f.deleted && (f.kind === 'book' || f.kind === 'comic' || /\.(epub|pdf|cbz|cbr|mobi)$/i.test(f.name))
    );

    const downloadMatch = /^\/download\/([^/]+)/i.exec(req.path);
    if (downloadMatch) {
      await serveFileContent(req, res, decodeURIComponent(downloadMatch[1]));
      return;
    }

    const coverMatch = /^\/cover\/([^/]+)/i.exec(req.path);
    if (coverMatch) {
      const book = store.files.find((f) => f.id === decodeURIComponent(coverMatch[1]));
      await sendArtworkForFile(req, res, store, book, postersCacheDir);
      return;
    }

    if (req.baseUrl === '/opdshelf' || req.path.includes('v2.0') || req.path.endsWith('.json')) {
      res.json({
        metadata: { title: 'AndreDrive OPDS Katalog', numberOfItems: books.length },
        links: [{ rel: 'self', href: `${origin}${req.originalUrl}`, type: 'application/opds+json' }],
        publications: books.map((b) => ({
          metadata: {
             '@type': 'http://schema.org/Book',
            title: b.metadata?.title || b.name.replace(/\.[^.]+$/, ''),
            identifier: `urn:andredrive:file:${b.id}`,
            author: b.metadata?.author || 'AndreDrive',
            modified: b.created,
          },
          links: [
            {
              rel: 'http://opds-spec.org/acquisition/open-access',
              href: `${origin}/opds/download/${encodeURIComponent(b.id)}/${encodeURIComponent(b.name)}`,
              type: b.mime || 'application/epub+zip',
            },
          ],
          images: [
            {
              href: `${origin}/opds/cover/${encodeURIComponent(b.id)}`,
              type: 'image/jpeg',
            },
          ],
        })),
      });
      return;
    }

    // Default OPDS 1.2 Atom XML feed
    const entriesXml = books
      .map(
        (b) => `
  <entry>
    <id>urn:andredrive:file:${xmlEsc(b.id)}</id>
    <title>${xmlEsc(b.metadata?.title || b.name)}</title>
    <updated>${xmlEsc(b.created || new Date().toISOString())}</updated>
    <author><name>${xmlEsc(b.metadata?.author || 'AndreDrive')}</name></author>
    <summary type="text">${xmlEsc(b.metadata?.plot || '')}</summary>
    <link rel="http://opds-spec.org/image" href="${origin}/opds/cover/${encodeURIComponent(b.id)}" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="${origin}/opds/download/${encodeURIComponent(b.id)}/${encodeURIComponent(b.name)}" type="${xmlEsc(b.mime || 'application/epub+zip')}"/>
  </entry>`
      )
      .join('');

    res.setHeader('Content-Type', 'application/atom+xml;profile=opds-catalog;kind=acquisition;charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:andredrive:opds:root</id>
  <title>AndreDrive Bücher &amp; Comics</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="${origin}/opds/v1.2/catalog.xml" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>${entriesXml}
</feed>`);
  });

  // ============================================================================
  // 6. AUDIOBOOKSHELF SERVER PROTOCOL (/audiobookshelf/*)
  // ============================================================================

  app.use('/audiobookshelf', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    const sub = req.path.replace(/\/+$/, '') || '/';
    const audiobooks = store.files.filter(
      (f) => !f.deleted && (f.kind === 'audiobook' || f.kind === 'podcast' || (f.mime || '').startsWith('audio/'))
    );

    if (sub === '/ping') {
      res.json({ success: true });
      return;
    }
    if (sub === '/status') {
      res.json({ isInit: true, language: 'de', serverVersion: '2.15.0' });
      return;
    }
    if (sub === '/login' && req.method === 'POST') {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '').trim();
      const acc =
        store.audiobookshelfAccounts.find(
          (a) => a.username.toLowerCase() === username.toLowerCase() && a.password === password
        ) || store.audiobookshelfAccounts[0];
      const token = acc ? `${acc.username}:${acc.password}` : 'abs-default-token';
      res.json({
        user: {
          id: acc?.id || 'abs-user-1',
          username: acc?.username || username || 'andre',
          type: 'root',
          token,
          mediaProgress: [],
          isActive: true,
        },
        userDefaultLibraryId: 'lib-audiobooks',
        serverSettings: { version: '2.15.0' },
      });
      return;
    }

    const coverMatch = /^\/api\/items\/([^/]+)\/cover$/i.exec(sub);
    if (coverMatch) {
      const file = store.files.find((f) => f.id === decodeURIComponent(coverMatch[1]));
      await sendArtworkForFile(req, res, store, file, postersCacheDir);
      return;
    }

    const fileMatch = /^\/api\/items\/([^/]+)\/(?:file\/[^/]+|download)$/i.exec(sub);
    if (fileMatch) {
      await serveFileContent(req, res, decodeURIComponent(fileMatch[1]));
      return;
    }

    if (sub === '/api/libraries') {
      res.json({
        libraries: [
          {
            id: 'lib-audiobooks',
            name: 'Hörbücher & Podcasts',
            folders: [{ id: 'folder-abs', fullPath: '/audiobooks', libraryId: 'lib-audiobooks' }],
            displayOrder: 1,
            icon: 'audiobookshelf',
            mediaType: 'book',
            provider: 'google',
          },
        ],
      });
      return;
    }

    if (/^\/api\/libraries\/[^/]+\/items$/i.test(sub)) {
      res.json({
        results: audiobooks.map((f) => ({
          id: f.id,
          ino: f.id,
          libraryId: 'lib-audiobooks',
          folderId: 'folder-abs',
          path: `/${f.name}`,
          relPath: f.name,
          isFile: true,
          mediaType: 'book',
          media: {
            id: `media-${f.id}`,
            libraryItemId: f.id,
            metadata: {
              title: f.metadata?.title || f.name.replace(/\.[^.]+$/, ''),
              authorName: f.metadata?.author || 'AndreDrive',
              description: f.metadata?.plot || '',
            },
            coverPath: `/audiobookshelf/api/items/${encodeURIComponent(f.id)}/cover`,
            duration: Math.max(60, parseDurationToSeconds(f.duration, f.metadata?.runtime_minutes)),
            size: f.size,
          },
        })),
        total: audiobooks.length,
        limit: 100,
        page: 0,
      });
      return;
    }

    res.json({ ok: true });
  });
}
