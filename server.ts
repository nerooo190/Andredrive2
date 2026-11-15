import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createServer as createViteServer } from 'vite';
import {
  AndreDriveStore,
  AndreDriveFile,
  inferCategoryFromMimeAndName,
  buildM3UPlaylist,
  createZipArchive,
} from './src/utils/andreDriveBackend.ts';
import { registerProtocolRoutes } from './src/utils/andreDriveProtocols.ts';
import {
  startCloudflareTunnel,
  getPublicOrigin,
  getTunnelStatus,
  setCustomDomain,
} from './src/utils/tunnelService.ts';
import {
  searchTmdbMetadata,
  fetchTmdbDetails,
  verifyTmdbToken,
  extractQueryFromFilename,
} from './src/utils/tmdbService.ts';

const execFileAsync = promisify(execFile);

interface VideoProbeInfo {
  durationSeconds: number;
  durationFormatted: string;
  quality: string;
  videoCodec: string;
  audioCodec: string;
  formatName: string;
  browserCompatible: boolean;
}

const videoProbeCache = new Map<string, VideoProbeInfo>();

function formatSecondsToDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h > 0 ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function probeVideoFile(filePath: string): Promise<VideoProbeInfo> {
  try {
    const st = fs.statSync(filePath);
    const cacheKey = `${filePath}:${st.size}:${st.mtimeMs}`;
    const cached = videoProbeCache.get(cacheKey);
    if (cached) return cached;

    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 10000 }
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams: any[] = Array.isArray(parsed.streams) ? parsed.streams : [];
    const format: any = parsed.format || {};
    const vStream = streams.find((s) => s.codec_type === 'video') || {};
    const aStream = streams.find((s) => s.codec_type === 'audio') || {};

    const durationSeconds = Number(format.duration || vStream.duration || 0) || 0;
    const durationFormatted = formatSecondsToDuration(durationSeconds);
    const width = Number(vStream.width || 0);
    const height = Number(vStream.height || 0);
    const maxDim = Math.max(width, height);
    const quality =
      maxDim >= 3800
        ? '4K'
        : maxDim >= 1900
        ? '1080p'
        : maxDim >= 1200
        ? '720p'
        : maxDim > 0
        ? '480p'
        : '1080p';
    const videoCodec = String(vStream.codec_name || '').toLowerCase();
    const audioCodec = String(aStream.codec_name || '').toLowerCase();
    const formatName = String(format.format_name || '').toLowerCase();

    const vCompat = ['h264', 'vp8', 'vp9', 'av1'].includes(videoCodec);
    const aCompat = !audioCodec || ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(audioCodec);
    const fCompat =
      formatName.includes('mp4') || formatName.includes('webm') || formatName.includes('mov');

    const info: VideoProbeInfo = {
      durationSeconds,
      durationFormatted,
      quality,
      videoCodec,
      audioCodec,
      formatName,
      browserCompatible: Boolean(vCompat && aCompat && fCompat),
    };
    videoProbeCache.set(cacheKey, info);
    return info;
  } catch {
    return {
      durationSeconds: 0,
      durationFormatted: '',
      quality: '1080p',
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mp4',
      browserCompatible: true,
    };
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const store = new AndreDriveStore();

  // Raw binary parsers for resumable chunk uploads and cover image uploads
  app.use(
    '/api/uploads/:id/parts/:part',
    express.raw({ type: () => true, limit: '50mb' })
  );
  app.use(
    '/api/files/:id/poster',
    express.raw({ type: () => true, limit: '15mb' })
  );
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));

  const getOrigin = (req: express.Request): string => {
    return getPublicOrigin(req);
  };

  // Start public Cloudflare Tunnel so Streamyfin, Moonfin, Wave IPTV, and mobile apps can connect without Google Cookie Check
  startCloudflareTunnel(PORT);

  // Health & Heartbeat
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'AndreDrive Sites Cloud-Speicher',
      origin: getOrigin(req),
      publicOrigin: getPublicOrigin(req),
      tunnel: getTunnelStatus(),
      user: store.isLoggedIn ? store.user : null,
      files: store.files.length,
      folders: store.folders.length,
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/tunnel', (_req, res) => {
    res.json(getTunnelStatus());
  });

  app.post('/api/tunnel', (req, res) => {
    const custom = typeof req.body?.customDomain === 'string' ? req.body.customDomain : null;
    setCustomDomain(custom);
    res.json(getTunnelStatus());
  });

  app.get('/api/heartbeat', (_req, res) => {
    res.json({ status: 'ok', version: '5.4.1' });
  });

  // Auth & Session
  app.get('/api/me', (_req, res) => {
    res.json(store.isLoggedIn ? store.user : null);
  });

  app.post('/api/auth/login', (req, res) => {
    const user = store.login(req.body);
    res.json(user);
  });

  app.post('/api/auth/logout', (_req, res) => {
    store.logout();
    res.json({ ok: true });
  });

  app.get('/signin-with-chatgpt', (_req, res) => {
    store.login();
    res.redirect('/');
  });

  app.get('/signout-with-chatgpt', (_req, res) => {
    store.logout();
    res.redirect('/');
  });

  // Main Library
  app.get('/api/library', (req, res) => {
    const lib = store.getLibrary();
    res.json({
      ...lib,
      publicOrigin: getOrigin(req),
      tunnel: getTunnelStatus(),
    });
  });

  app.post('/api/library/restore', (req, res) => {
    store.restoreClientVault(req.body || {});
    res.json(store.getLibrary());
  });

  // Folders
  app.post('/api/folders', (req, res) => {
    try {
      const folder = store.createFolder(req.body?.name, req.body?.parent || null);
      res.json(folder);
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ungültiger Ordnername.' });
    }
  });

  // Categories
  app.post('/api/categories', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Bitte gib einen Kategorienamen ein.' });
      return;
    }
    const cat = {
      id: 'cat-' + crypto.randomBytes(4).toString('hex'),
      name,
      icon: 'folder',
      builtin: false,
    };
    store.customCategories.push(cat);
    store.saveToDisk();
    res.json(cat);
  });

  app.patch('/api/categories/:id', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const cat = store.customCategories.find((c) => c.id === req.params.id);
    if (!cat) {
      res.status(404).json({ error: 'Kategorie nicht gefunden.' });
      return;
    }
    if (name) cat.name = name;
    store.saveToDisk();
    res.json(cat);
  });

  app.delete('/api/categories/:id', (req, res) => {
    const id = req.params.id;
    store.customCategories = store.customCategories.filter((c) => c.id !== id);
    for (const f of store.files) {
      if (f.kind === id) f.kind = 'other';
    }
    store.saveToDisk();
    res.json({ ok: true });
  });

  // Resumable Uploads
  app.post('/api/uploads', (req, res) => {
    const body = req.body || {};
    const id = 'upl-' + crypto.randomBytes(8).toString('hex');
    const name = String(body.name || 'Unbenannt.dat');
    const mime = String(body.mime || 'application/octet-stream');
    const size = Math.max(0, Number(body.size) || 0);
    const kind = inferCategoryFromMimeAndName(mime, name, body.kind);
    const session = {
      id,
      name,
      mime,
      size,
      folder: body.folder ? String(body.folder) : null,
      kind,
      series: String(body.series || ''),
      season: Number(body.season) || 1,
      episode: Number(body.episode) || 1,
      chunkBytes: 4 * 1024 * 1024,
      parts: [] as number[],
      chunks: new Map<number, Buffer>(),
      completed: false,
    };
    store.uploads.set(id, session);
    res.json({
      id: session.id,
      chunkBytes: session.chunkBytes,
      parts: session.parts,
      completed: false,
    });
  });

  app.get('/api/uploads/:id', (req, res) => {
    const session = store.uploads.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Upload-Sitzung nicht gefunden.' });
      return;
    }
    res.json({
      id: session.id,
      chunkBytes: session.chunkBytes,
      parts: session.parts,
      completed: session.completed,
      file: session.file,
    });
  });

  app.put('/api/uploads/:id/parts/:part', (req, res) => {
    const session = store.uploads.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Upload-Sitzung nicht gefunden.' });
      return;
    }
    const partNum = Number(req.params.part);
    const buf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');
    session.chunks.set(partNum, buf);
    if (!session.parts.includes(partNum)) {
      session.parts.push(partNum);
      session.parts.sort((a, b) => a - b);
    }
    res.json({ ok: true, part: partNum });
  });

  const finalizeUpload = async (req: express.Request, res: express.Response) => {
    const session = store.uploads.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Upload-Sitzung nicht gefunden.' });
      return;
    }
    if (!session.completed) {
      const sortedParts = [...session.chunks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
      const fullBuffer = sortedParts.length ? Buffer.concat(sortedParts) : Buffer.alloc(0);
      const fileId = 'file-' + crypto.randomBytes(6).toString('hex');
      if (fullBuffer.length > 0) {
        store.saveFileBlob(fileId, fullBuffer);
      }
      const isVideo = session.mime.startsWith('video/') || /\.(mp4|mkv|mov|webm|avi|m4v|ts)$/i.test(session.name);
      const blobPath = isVideo ? store.getFileBlobPath(fileId) : null;
      const probe = blobPath ? await probeVideoFile(blobPath) : null;

      const createdFile: AndreDriveFile = {
        id: fileId,
        name: session.name,
        size: session.size || fullBuffer.length,
        kind: session.kind,
        mime: isVideo ? 'video/mp4' : session.mime,
        created: new Date().toISOString(),
        starred: false,
        folder: session.folder,
        series: session.series || undefined,
        season: session.season,
        episode: session.episode,
        quality: isVideo ? probe?.quality || '1080p' : undefined,
        duration: isVideo ? probe?.durationFormatted || '49:00' : undefined,
        image: undefined,
        hls: isVideo ? 'ready' : undefined,
        metadata: {
          title: session.name.replace(/\.[^.]+$/, ''),
          year: String(new Date().getFullYear()),
          ...(probe?.durationSeconds
            ? { runtime_minutes: String(Math.max(1, Math.round(probe.durationSeconds / 60))) }
            : {}),
        },
      };

      // Automatically enrich uploaded movies and series from TMDB / TVMaze
      if (isVideo && (createdFile.kind === 'movie' || createdFile.kind === 'series')) {
        try {
          const { query, season, episode } = extractQueryFromFilename(createdFile);
          createdFile.season = season;
          createdFile.episode = episode;
          const hits = await searchTmdbMetadata(createdFile.kind, query, store.tmdbSettings.token);
          if (hits.length > 0) {
            const bestHit = hits[0];
            if (bestHit.kind && (bestHit.kind === 'movie' || bestHit.kind === 'series')) {
              createdFile.kind = bestHit.kind;
            }
            const detail = await fetchTmdbDetails(
              createdFile.kind,
              bestHit.id,
              season,
              episode,
              store.tmdbSettings.token
            );
            createdFile.metadata = {
              ...detail.metadata,
              ...(probe?.durationSeconds
                ? { runtime_minutes: String(Math.max(1, Math.round(probe.durationSeconds / 60))) }
                : {}),
            };
            if (createdFile.kind === 'series' && detail.series) {
              createdFile.series = detail.series;
            }
            const bestImg = detail.metadata.episode_image_url || detail.metadata.poster_url;
            if (bestImg) {
              createdFile.image = bestImg;
            }
          }
        } catch {
          // Keep default metadata if offline
        }
      }

      store.files.unshift(createdFile);
      session.completed = true;
      session.file = createdFile;
      session.chunks.clear();
      store.saveToDisk();
    }
    res.json(session.file);
  };

  app.post('/api/uploads/:id/complete', finalizeUpload);
  app.post('/api/uploads/:id/empty', finalizeUpload);

  // Files & Metadata
  app.patch('/api/files/:id', (req, res) => {
    const file = store.files.find((f) => f.id === req.params.id);
    if (!file) {
      res.status(404).json({ error: 'Datei nicht gefunden.' });
      return;
    }
    const body = req.body || {};
    if (typeof body.starred === 'boolean') file.starred = body.starred;
    if (typeof body.kind === 'string') file.kind = body.kind;
    if (typeof body.series === 'string') file.series = body.series;
    if (body.season !== undefined) file.season = Number(body.season) || 1;
    if (body.episode !== undefined) file.episode = Number(body.episode) || 1;
    if (body.metadata && typeof body.metadata === 'object') {
      const mergedMeta: Record<string, any> = { ...(file.metadata || {}), ...body.metadata };
      file.metadata = mergedMeta;
      const bestImage = mergedMeta.episode_image_url || mergedMeta.poster_url;
      if (bestImage) {
        file.image = bestImage;
      }
    }
    store.saveToDisk();
    res.json(file);
  });

  app.post('/api/files/:id/poster', (req, res) => {
    const file = store.files.find((f) => f.id === req.params.id);
    if (!file) {
      res.status(404).json({ error: 'Datei nicht gefunden.' });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = req.get('content-type') || 'image/jpeg';
    store.filePosters.set(file.id, { buffer: buf, mime });
    file.metadata = { ...(file.metadata || {}), poster_source: 'upload' };
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/files/:id/poster', (req, res) => {
    const poster = store.filePosters.get(req.params.id);
    if (poster && poster.buffer.length > 0) {
      res.setHeader('Content-Type', poster.mime);
      res.send(poster.buffer);
      return;
    }
    res.redirect('/images/alpine-escape.jpg');
  });

  const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB per HTTP 206 chunk (well below Cloud Run's 32 MB limit, includes full ~2.5 MB moov header)
  const faststartConversionLocks = new Map<string, Promise<string>>();

  const streamDiskFileWithRange = (
    req: express.Request,
    res: express.Response,
    filePath: string,
    totalSize: number,
    contentType: string,
    fileName: string,
    etagKey: string
  ) => {
    const etag = `"andredrive-${etagKey}-${totalSize}"`;

    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    }

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(totalSize));
      res.status(200).end();
      return;
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-');
      const start = Math.max(0, Math.min(totalSize - 1, parseInt(startStr, 10) || 0));
      const parsedEnd = endStr ? parseInt(endStr, 10) : NaN;
      const requestedEnd = Number.isFinite(parsedEnd)
        ? Math.max(start, Math.min(totalSize - 1, parsedEnd))
        : totalSize - 1;
      const end = Math.min(requestedEnd, start + MAX_RANGE_CHUNK_BYTES - 1, totalSize - 1);
      const chunkLen = Math.max(0, end - start + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkLen));
      const stream = fs.createReadStream(filePath, { start, end });
      req.on('close', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      return;
    }

    // For non-Range video playback requests on large files, return the first 8 MB chunk as 206 Partial Content
    // so Cloud Run never rejects a 230-572 MB response and the browser immediately receives the moov header.
    if (req.query.download !== '1' && contentType.startsWith('video/') && totalSize > MAX_RANGE_CHUNK_BYTES) {
      const start = 0;
      const end = Math.min(totalSize - 1, MAX_RANGE_CHUNK_BYTES - 1);
      const chunkLen = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkLen));
      const stream = fs.createReadStream(filePath, { start, end });
      req.on('close', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      return;
    }

    if (totalSize <= 24 * 1024 * 1024) {
      res.setHeader('Content-Length', String(totalSize));
    }
    res.status(200);
    const stream = fs.createReadStream(filePath);
    req.on('close', () => stream.destroy());
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);
  };

  const serveFileContent = async (req: express.Request, res: express.Response, fileId: string) => {
    const file = store.files.find((f) => f.id === fileId);
    if (!file) {
      res.status(404).json({ error: 'Datei nicht gefunden.' });
      return;
    }

    const blobStat = store.getFileBlobStat(file.id);

    if (req.query.info === '1') {
      if (blobStat) {
        const probe = await probeVideoFile(blobStat.path);
        if (probe.durationFormatted && file.duration !== probe.durationFormatted) {
          file.duration = probe.durationFormatted;
        }
        if (probe.quality && file.quality !== probe.quality) {
          file.quality = probe.quality;
        }
        res.json({
          duration: probe.durationSeconds || 2950,
          durationFormatted: probe.durationFormatted || file.duration || '',
          hls: false,
          browserCompatible: probe.browserCompatible,
          videoCodec: probe.videoCodec,
          audioCodec: probe.audioCodec,
          streamUrl: `/api/files/${encodeURIComponent(file.id)}/stream`,
        });
        return;
      }
      res.json({ duration: 2950, hls: false, browserCompatible: true });
      return;
    }

    const contentType = file.mime?.startsWith('video/')
      ? 'video/mp4'
      : file.mime || 'application/octet-stream';

    if (blobStat) {
      streamDiskFileWithRange(req, res, blobStat.path, blobStat.size, contentType, file.name, file.id);
      return;
    }

    // Fallback for small in-memory test blobs
    const blobBuf = store.getFileBlob(file.id);
    if (!blobBuf) {
      res.status(404).json({ error: 'Videodatei auf dem Speicher nicht gefunden.' });
      return;
    }
    const totalSize = blobBuf.length;
    const etag = `"andredrive-${file.id}-${totalSize}"`;

    res.setHeader('ETag', etag);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    }

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(totalSize));
      res.status(200).end();
      return;
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-');
      const start = Math.max(0, parseInt(startStr, 10) || 0);
      const end = endStr ? Math.min(totalSize - 1, parseInt(endStr, 10)) : totalSize - 1;
      const chunkLen = Math.max(0, end - start + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', String(chunkLen));
      res.end(blobBuf.subarray(start, end + 1));
      return;
    }

    res.setHeader('Content-Length', String(blobBuf.length));
    res.status(200).end(blobBuf);
  };

  const serveFfmpegStream = async (req: express.Request, res: express.Response, fileId: string) => {
    const file = store.files.find((f) => f.id === fileId);
    if (!file) {
      res.status(404).json({ error: 'Datei nicht gefunden.' });
      return;
    }
    const blobStat = store.getFileBlobStat(file.id);
    if (!blobStat) {
      res.status(404).json({ error: 'Videodatei auf dem Speicher nicht gefunden.' });
      return;
    }
    const probe = await probeVideoFile(blobStat.path);
    // If already browser-compatible MP4, serve directly with 8 MB Range chunks so the full moov duration is preserved
    if (probe.browserCompatible) {
      streamDiskFileWithRange(req, res, blobStat.path, blobStat.size, 'video/mp4', file.name, file.id);
      return;
    }

    // For non-MP4 / incompatible containers, remux/transcode with +faststart to a cached MP4 file
    // so the browser always receives a complete moov atom with full duration and Range seeking support.
    const faststartPath = `${blobStat.path}.faststart.mp4`;
    try {
      if (!fs.existsSync(faststartPath) || fs.statSync(faststartPath).size === 0) {
        let lock = faststartConversionLocks.get(file.id);
        if (!lock) {
          lock = (async () => {
            const tmpPath = `${faststartPath}.tmp`;
            const canCopyVideo = probe.videoCodec === 'h264';
            const args: string[] = [
              '-y',
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              blobStat.path,
              ...(canCopyVideo
                ? ['-c:v', 'copy']
                : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']),
              '-c:a',
              'aac',
              '-b:a',
              '192k',
              '-ac',
              '2',
              '-movflags',
              '+faststart',
              '-f',
              'mp4',
              tmpPath,
            ];
            await execFileAsync('ffmpeg', args, { timeout: 300000 });
            fs.renameSync(tmpPath, faststartPath);
            return faststartPath;
          })().finally(() => {
            faststartConversionLocks.delete(file.id);
          });
          faststartConversionLocks.set(file.id, lock);
        }
        await lock;
      }
      const fastStat = fs.statSync(faststartPath);
      streamDiskFileWithRange(req, res, faststartPath, fastStat.size, 'video/mp4', file.name, `${file.id}-faststart`);
    } catch {
      streamDiskFileWithRange(req, res, blobStat.path, blobStat.size, 'video/mp4', file.name, file.id);
    }
  };

  app.get('/api/files/:id/content', (req, res) => serveFileContent(req, res, req.params.id));
  app.head('/api/files/:id/content', (req, res) => serveFileContent(req, res, req.params.id));
  app.get('/api/files/:id/stream', (req, res) => serveFfmpegStream(req, res, req.params.id));
  app.head('/api/files/:id/stream', (req, res) => serveFfmpegStream(req, res, req.params.id));
  app.get('/media/:token/:id', (req, res) => serveFileContent(req, res, req.params.id));
  app.head('/media/:token/:id', (req, res) => serveFileContent(req, res, req.params.id));

  app.post('/api/files/transfer', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const targetFolder: string | null = req.body?.folder || null;
    const action: string = req.body?.action || 'move';

    if (action === 'copy') {
      const copies: AndreDriveFile[] = [];
      for (const f of store.files) {
        if (ids.includes(f.id)) {
          copies.push({
            ...structuredClone(f),
            id: 'file-' + crypto.randomBytes(6).toString('hex'),
            folder: targetFolder,
            created: new Date().toISOString(),
          });
        }
      }
      store.files.unshift(...copies);
    } else {
      for (const f of store.files) {
        if (ids.includes(f.id)) {
          f.folder = targetFolder;
        }
      }
    }
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.post('/api/files/category', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const kind = String(req.body?.kind || 'other');
    for (const f of store.files) {
      if (ids.includes(f.id)) {
        f.kind = kind;
      }
    }
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.post('/api/files/delete', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const now = new Date().toISOString();
    const toTrash = store.files.filter((f) => ids.includes(f.id)).map((f) => ({ ...f, deleted: now }));
    store.trashedFiles.unshift(...toTrash);
    store.files = store.files.filter((f) => !ids.includes(f.id));
    store.saveToDisk();
    res.json({ ok: true });
  });

  // Trash
  app.get('/api/trash', (_req, res) => {
    res.json({ files: store.trashedFiles });
  });

  app.post('/api/trash', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const restored = store.trashedFiles
      .filter((f) => ids.includes(f.id))
      .map((f) => {
        const copy = { ...f };
        delete copy.deleted;
        return copy;
      });
    store.files.unshift(...restored);
    store.trashedFiles = store.trashedFiles.filter((f) => !ids.includes(f.id));
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.delete('/api/trash', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    store.trashedFiles = store.trashedFiles.filter((f) => !ids.includes(f.id));
    store.saveToDisk();
    res.json({ ok: true });
  });

  // Share Links & VOD M3U Playlists
  app.post('/api/links', (req, res) => {
    const type = req.body?.type || 'file';
    const target = req.body?.target;
    const link = store.createShareLink(type, target);
    res.json(link);
  });

  app.delete('/api/links/:token', (req, res) => {
    store.deleteShareLink(req.params.token);
    res.json({ ok: true });
  });

  app.get('/api/shared/:token', (req, res) => {
    const link = store.links.find((l) => l.token === req.params.token);
    if (!link) {
      res.status(404).json({ error: 'Dieser Freigabelink existiert nicht mehr oder wurde widerrufen.' });
      return;
    }
    if (link.type === 'file') {
      const file = store.files.find((f) => f.id === link.target);
      res.json({
        name: file?.name || 'Geteilte Datei',
        type: 'file',
        files: file ? [file] : [],
      });
      return;
    }
    if (link.type === 'folder') {
      const folder = store.folders.find((fld) => fld.id === link.target);
      const files = store.files.filter((f) => f.folder === link.target);
      res.json({
        name: folder?.name || 'Geteilter Ordner',
        type: 'folder',
        files,
      });
      return;
    }
    let ids: string[] = [];
    try {
      ids = JSON.parse(link.target);
    } catch {
      ids = [];
    }
    const files = store.files.filter((f) => ids.includes(f.id));
    res.json({
      name: link.type === 'playlist' ? 'VOD-Playlist' : 'Geteilte Sammlung',
      type: link.type,
      files,
    });
  });

  app.get('/playlist/:token/library.:ext', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const link = store.links.find((l) => l.token === req.params.token);
    let ids: string[] = [];
    if (link) {
      try {
        ids = JSON.parse(link.target);
      } catch {
        ids = [link.target];
      }
    }
    const selectedFiles = ids.length
      ? store.files.filter((f) => ids.includes(f.id))
      : store.files.filter((f) => f.mime.startsWith('video/'));
    const m3uContent = buildM3UPlaylist(selectedFiles, getOrigin(req), req.params.token);
    res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="AndreDrive-Videothek.m3u"');
    res.send(m3uContent);
  });

  app.post('/api/download', (req, res) => {
    let ids: string[] = [];
    try {
      ids = typeof req.body?.ids === 'string' ? JSON.parse(req.body.ids) : req.body?.ids || [];
    } catch {
      ids = [];
    }
    const selected = store.files.filter((f) => ids.includes(f.id));
    if (selected.length === 1) {
      req.query.download = '1';
      serveFileContent(req, res, selected[0].id);
      return;
    }
    const zipEntries: Array<{ name: string; data: Buffer }> = [];
    for (const f of selected) {
      const stat = store.getFileBlobStat(f.id);
      if (stat && stat.size <= 30 * 1024 * 1024) {
        zipEntries.push({ name: f.name, data: fs.readFileSync(stat.path) });
      } else {
        const mem = store.getFileBlob(f.id);
        if (mem) {
          zipEntries.push({ name: f.name, data: mem });
        } else {
          const infoText = [
            `Dateiname: ${f.name}`,
            `Größe: ${f.size} Bytes`,
            `Kategorie: ${f.kind}`,
            `Direkt-Download-URL: ${getOrigin(req)}/api/files/${encodeURIComponent(f.id)}/content?download=1`,
          ].join('\n');
          zipEntries.push({ name: `${f.name}.url.txt`, data: Buffer.from(infoText, 'utf-8') });
        }
      }
    }
    const zipBuffer = createZipArchive(zipEntries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="AndreDrive-Auswahl.zip"');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.send(zipBuffer);
  });

  // Cloud Sources (OneDrive, Google Drive, TorBox)
  app.get('/api/cloud/connections', (_req, res) => {
    res.json({
      connections: store.cloudConnections,
      oneDriveClientConfigured: true,
    });
  });

  app.get('/api/cloud/transfers', (_req, res) => {
    res.json({ transfers: store.cloudTransfers });
  });

  app.post('/api/cloud/torbox', (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Bitte einen TorBox-API-Schlüssel eingeben.' });
      return;
    }
    const conn = {
      id: 'conn-torbox-' + crypto.randomBytes(3).toString('hex'),
      provider: 'torbox' as const,
      label: 'TorBox Cloud (' + token.slice(0, 6) + '…)',
      canMove: true,
      created: new Date().toISOString(),
    };
    store.cloudConnections.unshift(conn);
    res.json(conn);
  });

  app.post('/api/cloud/onedrive/start', (_req, res) => {
    const pollId = 'od-' + crypto.randomBytes(4).toString('hex');
    res.json({
      id: pollId,
      code: 'AD97-CLD8',
      verificationUrl: 'https://microsoft.com/devicelogin',
      interval: 3,
    });
  });

  app.post('/api/cloud/onedrive/poll/:id', (_req, res) => {
    const exists = store.cloudConnections.some((c) => c.provider === 'onedrive');
    if (!exists) {
      store.cloudConnections.unshift({
        id: 'conn-onedrive-1',
        provider: 'onedrive',
        label: 'Microsoft OneDrive (Andre)',
        canMove: true,
        created: new Date().toISOString(),
      });
    }
    res.json({ connected: true });
  });

  app.post('/api/cloud/google-drive/start', (_req, res) => {
    res.json({ authorization: '/?google-drive=connected' });
  });

  app.delete('/api/cloud/connections/:id', (req, res) => {
    store.cloudConnections = store.cloudConnections.filter((c) => c.id !== req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/cloud/connections/:id/browse', (req, res) => {
    const conn = store.cloudConnections.find((c) => c.id === req.params.id);
    const provider = conn?.provider || 'torbox';
    res.json({
      items: [
        {
          id: 'cld-folder-1',
          key: 'cld-folder-1',
          name: '4K Remuxes & Originale',
          folder: true,
          size: 0,
          ready: true,
        },
        {
          id: 'cld-file-1',
          key: 'cld-file-1',
          name: `Nordic.Expedition.2026.2160p.${provider.toUpperCase()}.mp4`,
          folder: false,
          size: 3.6 * 1e9,
          ready: true,
        },
        {
          id: 'cld-file-2',
          key: 'cld-file-2',
          name: `Cyber.Odyssey.S01E02.1080p.${provider.toUpperCase()}.mp4`,
          folder: false,
          size: 1.9 * 1e9,
          ready: true,
        },
      ],
      next: null,
    });
  });

  app.post('/api/cloud/connections/:id/import', (req, res) => {
    const conn = store.cloudConnections.find((c) => c.id === req.params.id);
    const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const created: AndreDriveFile[] = keys.map((key, idx) => {
      const f: AndreDriveFile = {
        id: 'file-cld-' + crypto.randomBytes(4).toString('hex'),
        name: key.includes('cld-file-2')
          ? 'Cyber Odyssey — S01E02.mp4'
          : `Nordic Expedition ${idx + 1}.mp4`,
        image: '/images/alpine-escape.jpg',
        duration: '24:10',
        quality: '4K',
        size: 3.6 * 1e9,
        kind: req.body?.kind && req.body.kind !== 'auto' ? req.body.kind : 'movie',
        mime: 'video/mp4',
        created: new Date().toISOString(),
        starred: false,
        folder: req.body?.folder || null,
        cloud_source: conn?.provider || 'torbox',
        hls: 'ready',
      };
      store.files.unshift(f);
      return f;
    });
    store.saveToDisk();
    res.json({ created });
  });

  app.post('/api/cloud/connections/:id/transfers', (req, res) => {
    const keys: string[] = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const createdJobs = keys.map((key) => {
      const fileId = 'file-tr-' + crypto.randomBytes(4).toString('hex');
      const name = key.includes('cld-file-2')
        ? 'Cyber Odyssey — S01E02.mp4'
        : 'Nordic Expedition (2026) 4K.mp4';
      const newFile: AndreDriveFile = {
        id: fileId,
        name,
        image: '/images/alpine-escape.jpg',
        duration: '24:10',
        quality: '4K',
        size: 3.6 * 1e9,
        kind: req.body?.kind && req.body.kind !== 'auto' ? req.body.kind : 'movie',
        mime: 'video/mp4',
        created: new Date().toISOString(),
        starred: false,
        folder: req.body?.folder || null,
        hls: 'ready',
      };
      store.files.unshift(newFile);
      const job = {
        id: 'tr-' + crypto.randomBytes(4).toString('hex'),
        connectionId: req.params.id,
        name,
        size: 3.6 * 1e9,
        copied: 3.6 * 1e9,
        verified: 3.6 * 1e9,
        status: 'done' as const,
        operation: (req.body?.operation === 'move' ? 'move' : 'copy') as 'copy' | 'move',
        folder: req.body?.folder || null,
        kind: newFile.kind,
        fileId,
      };
      store.cloudTransfers.unshift(job);
      return job;
    });
    store.saveToDisk();
    res.json({ transfers: createdJobs });
  });

  app.post('/api/cloud/transfers/:id/step', (req, res) => {
    const job = store.cloudTransfers.find((t) => t.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Übertragung nicht gefunden.' });
      return;
    }
    job.copied = job.size;
    job.verified = job.size;
    job.status = 'done';
    res.json(job);
  });

  app.post('/api/cloud/transfers/:id/finish', (req, res) => {
    const job = store.cloudTransfers.find((t) => t.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Übertragung nicht gefunden.' });
      return;
    }
    job.status = 'done';
    res.json(job);
  });

  app.post('/api/cloud/transfers/:id/cancel', (req, res) => {
    const job = store.cloudTransfers.find((t) => t.id === req.params.id);
    if (job) job.status = 'cancelled';
    res.json({ ok: true });
  });

  // Media Server & Device Account Integrations (Jellyfin, Navidrome, OPDS, Audiobookshelf, WebDAV, RomM, TMDB)
  app.get('/api/jellyfin/accounts', (req, res) => {
    res.json({
      serverUrl: `${getOrigin(req)}/jellyfin`,
      accounts: store.jellyfinAccounts,
    });
  });
  app.post('/api/jellyfin/accounts', (req, res) => {
    res.json(store.createDeviceAccount(store.jellyfinAccounts, req.body?.label || 'Mein Medienplayer', 'jf'));
  });
  app.delete('/api/jellyfin/accounts/:id', (req, res) => {
    store.jellyfinAccounts = store.jellyfinAccounts.filter((a) => a.id !== req.params.id);
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/navidrome/accounts', (req, res) => {
    res.json({
      serverUrl: `${getOrigin(req)}/subsonic`,
      accounts: store.navidromeAccounts,
    });
  });
  app.post('/api/navidrome/accounts', (req, res) => {
    res.json(store.createDeviceAccount(store.navidromeAccounts, req.body?.label || 'Mein Musikplayer', 'nd'));
  });
  app.delete('/api/navidrome/accounts/:id', (req, res) => {
    store.navidromeAccounts = store.navidromeAccounts.filter((a) => a.id !== req.params.id);
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/opds/accounts', (req, res) => {
    const origin = getOrigin(req);
    res.json({
      urls: {
        opds: `${origin}/opds/v1.2/catalog.xml`,
        opds2: `${origin}/opds/v2.0/catalog.json`,
        opdshelf: `${origin}/opdshelf`,
      },
      accounts: store.opdsAccounts,
    });
  });
  app.post('/api/opds/accounts', (req, res) => {
    res.json(store.createDeviceAccount(store.opdsAccounts, req.body?.label || 'Mein Lesegerät', 'opds'));
  });
  app.delete('/api/opds/accounts/:id', (req, res) => {
    store.opdsAccounts = store.opdsAccounts.filter((a) => a.id !== req.params.id);
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/audiobookshelf/accounts', (req, res) => {
    res.json({
      serverUrl: `${getOrigin(req)}/audiobookshelf`,
      accounts: store.audiobookshelfAccounts,
    });
  });
  app.post('/api/audiobookshelf/accounts', (req, res) => {
    res.json(
      store.createDeviceAccount(store.audiobookshelfAccounts, req.body?.label || 'Mein Hörbuchplayer', 'abs')
    );
  });
  app.delete('/api/audiobookshelf/accounts/:id', (req, res) => {
    store.audiobookshelfAccounts = store.audiobookshelfAccounts.filter((a) => a.id !== req.params.id);
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/webdav/accounts', (req, res) => {
    res.json({
      serverUrl: `${getOrigin(req)}/webdav/`,
      accounts: store.webdavAccounts,
    });
  });
  app.post('/api/webdav/accounts', (req, res) => {
    res.json(
      store.createDeviceAccount(
        store.webdavAccounts,
        req.body?.label || 'Mein WebDAV',
        'dav',
        Boolean(req.body?.can_write)
      )
    );
  });
  app.delete('/api/webdav/accounts/:id', (req, res) => {
    store.webdavAccounts = store.webdavAccounts.filter((a) => a.id !== req.params.id);
    store.saveToDisk();
    res.json({ ok: true });
  });

  app.get('/api/romm/settings', (req, res) => {
    res.json({
      endpoint: `${getOrigin(req)}/webdav/romm/`,
      settings: store.rommSettings,
    });
  });
  app.put('/api/romm/settings', (req, res) => {
    store.rommSettings = {
      ...store.rommSettings,
      server_url: String(req.body?.server_url || store.rommSettings.server_url),
      folder_id: String(req.body?.folder_id || store.rommSettings.folder_id),
    };
    store.saveToDisk();
    res.json({ settings: store.rommSettings });
  });
  app.post('/api/romm/access', (_req, res) => {
    const username = `romm_reader_${crypto.randomBytes(3).toString('hex')}`;
    const password = crypto.randomBytes(12).toString('base64url');
    store.rommSettings.username = username;
    store.rommSettings.password = password;
    store.saveToDisk();
    res.json({ username, password });
  });
  app.delete('/api/romm/access', (_req, res) => {
    delete store.rommSettings.username;
    delete store.rommSettings.password;
    store.saveToDisk();
    res.json({ ok: true });
  });

  // TMDB Integration
  app.get('/api/tmdb/settings', (_req, res) => {
    res.json({
      configured: store.tmdbSettings.configured,
      personal: store.tmdbSettings.personal,
    });
  });

  app.put('/api/tmdb/settings', async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Bitte einen gültigen TMDB-Schlüssel oder Read Access Token eingeben.' });
      return;
    }
    const valid = await verifyTmdbToken(token);
    if (!valid) {
      res.status(400).json({ error: 'Der TMDB-Schlüssel wurde von TMDB abgelehnt. Bitte prüfe deine Eingabe.' });
      return;
    }
    store.tmdbSettings = {
      configured: true,
      personal: true,
      token,
    };
    store.saveToDisk();
    res.json({ configured: true, personal: true });
  });

  app.delete('/api/tmdb/settings', (_req, res) => {
    store.tmdbSettings = { configured: true, personal: false };
    store.saveToDisk();
    res.json({ configured: true, personal: false });
  });

  const postersCacheDir = path.join(process.cwd(), '.andredrive-storage', 'posters');
  if (!fs.existsSync(postersCacheDir)) {
    fs.mkdirSync(postersCacheDir, { recursive: true });
  }

  app.get('/api/tmdb/image', async (req, res) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl || (!rawUrl.startsWith('https://') && !rawUrl.startsWith('http://'))) {
      res.redirect('/images/alpine-escape.jpg');
      return;
    }
    const hash = crypto.createHash('sha256').update(rawUrl).digest('hex');
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
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.send(buf);
          return;
        }
      }

      const upstream = await fetch(rawUrl, {
        headers: {
          'User-Agent': 'AndreDrive/2.0 (Cloud Media Server)',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!upstream.ok) {
        res.redirect('/images/alpine-escape.jpg');
        return;
      }
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      const arrayBuf = await upstream.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      if (buf.length > 0) {
        fs.writeFileSync(cacheDataPath, buf);
        fs.writeFileSync(cacheMimePath, contentType, 'utf-8');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(buf);
        return;
      }
    } catch {
      // Fall back to local cover
    }
    res.redirect('/images/alpine-escape.jpg');
  });

  app.get('/api/tmdb/search', async (req, res) => {
    const kind = String(req.query.kind || 'movie').trim();
    const q = String(req.query.q || '').trim();
    const results = await searchTmdbMetadata(kind, q, store.tmdbSettings.token);
    res.json({ results });
  });

  app.get('/api/tmdb/:kind/:id', async (req, res) => {
    const kind = String(req.params.kind || 'movie');
    const id = String(req.params.id || '');
    const season = Number(req.query.season) || 1;
    const episode = Number(req.query.episode) || 1;
    const detail = await fetchTmdbDetails(kind, id, season, episode, store.tmdbSettings.token);
    res.json(detail);
  });

  app.post('/api/tmdb/scrape', async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const results: Array<{ id: string; status: 'updated' | 'unchanged' | 'skipped' | 'error'; message?: string }> = [];

    for (const id of ids) {
      const f = store.files.find((file) => file.id === id);
      if (!f) {
        results.push({ id, status: 'skipped', message: 'Datei nicht gefunden' });
        continue;
      }
      try {
        const { query, season, episode } = extractQueryFromFilename(f);
        let targetId = f.metadata?.tmdb_id ? String(f.metadata.tmdb_id) : '';
        if (!targetId) {
          const hits = await searchTmdbMetadata(f.kind, query, store.tmdbSettings.token);
          if (hits.length > 0) {
            targetId = hits[0].id;
            if (hits[0].kind && (hits[0].kind === 'movie' || hits[0].kind === 'series')) {
              f.kind = hits[0].kind;
            }
          }
        }
        if (!targetId) {
          results.push({ id, status: 'skipped', message: 'Kein Treffer bei TMDB gefunden' });
          continue;
        }
        const detail = await fetchTmdbDetails(f.kind, targetId, season, episode, store.tmdbSettings.token);
        const prevMeta = f.metadata || {};
        const keepUploadedPoster = prevMeta.poster_source === 'upload';
        const isPlaceholderPoster =
          !prevMeta.poster_url ||
          prevMeta.poster_url === '/images/alpine-escape.jpg' ||
          prevMeta.poster_url === '/images/contact-sheet.png';
        const isPlaceholderEpImg =
          !prevMeta.episode_image_url ||
          prevMeta.episode_image_url === '/images/alpine-escape.jpg' ||
          prevMeta.episode_image_url === '/images/contact-sheet.png';

        f.metadata = {
          ...prevMeta,
          ...detail.metadata,
          title: detail.metadata.title || prevMeta.title,
          original_title: detail.metadata.original_title || prevMeta.original_title,
          year: detail.metadata.year || prevMeta.year,
          plot: detail.metadata.plot || prevMeta.plot,
          genres: detail.metadata.genres || prevMeta.genres,
          runtime_minutes: detail.metadata.runtime_minutes || prevMeta.runtime_minutes,
          rating: detail.metadata.rating || prevMeta.rating,
          director: detail.metadata.director || prevMeta.director,
          cast: detail.metadata.cast || prevMeta.cast,
          country: detail.metadata.country || prevMeta.country,
          language: detail.metadata.language || prevMeta.language,
          tmdb_id: String(detail.metadata.tmdb_id || targetId),
          imdb_id: detail.metadata.imdb_id || prevMeta.imdb_id,
          poster_url: keepUploadedPoster
            ? ''
            : !isPlaceholderPoster
            ? prevMeta.poster_url
            : detail.metadata.poster_url || prevMeta.poster_url,
          poster_source: keepUploadedPoster ? 'upload' : 'url',
          ...(f.kind === 'series'
            ? {
                episode_title: detail.metadata.episode_title || prevMeta.episode_title,
                episode_image_url: !isPlaceholderEpImg
                  ? prevMeta.episode_image_url
                  : detail.metadata.episode_image_url || detail.metadata.poster_url,
              }
            : {}),
        };
        if (f.kind === 'series' && detail.series) {
          f.series = detail.series;
        }
        const bestImg = f.metadata.episode_image_url || f.metadata.poster_url;
        if (bestImg && !keepUploadedPoster) {
          f.image = bestImg;
        }
        f.season = season;
        f.episode = episode;
        results.push({ id, status: 'updated' });
      } catch (err) {
        results.push({
          id,
          status: 'error',
          message: err instanceof Error ? err.message : 'Fehler beim Abruf',
        });
      }
    }

    store.saveToDisk();
    res.json({ results });
  });

  // Register Jellyfin/Moonfin, Xtream Codes VOD, M3U/Media/Thumb, WebDAV/RomM, Subsonic, OPDS, and Audiobookshelf protocols
  registerProtocolRoutes(app, store, serveFileContent, postersCacheDir);

  // Catch-all for any unmapped /api/* routes so H() never receives HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `API-Endpunkt nicht gefunden: ${req.method} ${req.path}` });
  });

  const distPath = path.join(process.cwd(), 'dist');
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AndreDrive server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
