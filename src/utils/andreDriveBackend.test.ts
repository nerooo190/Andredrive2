import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AndreDriveStore,
  generateShareToken,
  inferCategoryFromMimeAndName,
  buildM3UPlaylist,
  parseDurationToSeconds,
  createZipArchive,
} from './andreDriveBackend.ts';
import { jellyHexId, normalizeJellyId } from './andreDriveProtocols.ts';
import {
  searchTmdbMetadata,
  fetchTmdbDetails,
  extractQueryFromFilename,
} from './tmdbService.ts';

describe('AndreDrive Backend Engine', () => {
  it('generates 64-character hex tokens for Xtream username/password splitting', () => {
    const token = generateShareToken();
    assert.equal(token.length, 64);
    assert.match(token, /^[0-9a-f]{64}$/);
    const username = token.slice(0, 32);
    const password = token.slice(32);
    assert.equal(username.length, 32);
    assert.equal(password.length, 32);
  });

  it('starts with 0 demo placeholder videos and upgrades real uploaded Tausend Meilen Staub videos with authentic metadata and durations', () => {
    const store = new AndreDriveStore(null);
    const lib = store.getLibrary();
    assert.equal(lib.folders.length, 4);
    assert.equal(lib.files.length, 0);
    assert.equal(lib.categories.length, 12);

    // Simulate the user's real uploaded Tausend Meilen Staub videos (including one previously mis-scraped as One in a Million)
    store.restoreClientVault({
      files: [
        {
          id: 'file-alpine-escape', // placeholder — must be stripped out!
          name: 'Alpine Escape.mp4',
          size: 2400000000,
          kind: 'movie',
          mime: 'video/mp4',
          created: new Date().toISOString(),
          starred: false,
          folder: 'd1',
        },
        {
          id: 'file-4b2bbc107af9',
          name: 'Tausend Meilen Staub S01E01.mp4',
          size: 572116508,
          kind: 'movie',
          mime: 'video/mp4',
          created: '2026-04-19T12:25:52.712Z',
          starred: false,
          folder: 'fld-10e550cf976f',
          duration: '03:15',
          image: '/images/alpine-escape.jpg',
          metadata: {
            title: 'One in a Million',
            year: '2006',
            tmdb_id: '4065',
          },
        },
        {
          id: 'file-9660a0b669fe',
          name: 'Tausend Meilen Staub S01E02.mp4',
          size: 399999471,
          kind: 'movie',
          mime: 'video/mp4',
          created: '2026-04-19T12:25:47.590Z',
          starred: false,
          folder: 'fld-10e550cf976f',
          duration: '03:15',
          image: '/images/alpine-escape.jpg',
          metadata: {
            title: 'One in a Million',
            year: '2006',
            tmdb_id: '4065',
          },
        },
      ],
    });

    assert.equal(store.files.length, 2, 'Placeholder file-alpine-escape must be ignored and only real uploads kept');
    const ep1 = store.files.find((f) => f.id === 'file-4b2bbc107af9')!;
    const ep2 = store.files.find((f) => f.id === 'file-9660a0b669fe')!;
    assert.equal(ep1.kind, 'series');
    assert.equal(ep1.series, 'Tausend Meilen Staub');
    assert.equal(ep1.season, 1);
    assert.equal(ep1.episode, 1);
    assert.equal(ep1.duration, '49:11');
    assert.equal(ep1.metadata?.title, 'Tausend Meilen Staub');
    assert.equal(ep1.metadata?.original_title, 'Rawhide');
    assert.ok(ep1.metadata?.episode_title?.includes('Fluch des Goldes'));
    assert.ok(ep1.metadata?.cast?.includes('Clint Eastwood'));
    assert.ok(ep1.image?.startsWith('/api/tmdb/image?url='));

    assert.equal(ep2.kind, 'series');
    assert.equal(ep2.episode, 2);
    assert.equal(ep2.duration, '48:55');
    assert.ok(ep2.metadata?.episode_title?.includes('Unruhe in Alamosa'));
  });

  it('creates folders, share links, and rich M3U playlists with real duration in seconds and absolute artwork URLs', () => {
    const store = new AndreDriveStore(null);
    const folder = store.createFolder('Meine Dokus', null);
    assert.equal(folder.name, 'Meine Dokus');
    assert.equal(store.folders.length, 5);

    store.restoreClientVault({
      files: [
        {
          id: 'file-4b2bbc107af9',
          name: 'Tausend Meilen Staub S01E01.mp4',
          size: 572116508,
          kind: 'series',
          mime: 'video/mp4',
          created: new Date().toISOString(),
          starred: false,
          folder: 'd2',
        },
      ],
    });

    const link = store.createShareLink('playlist', ['file-4b2bbc107af9']);
    assert.equal(link.token.length, 64);
    assert.equal(link.type, 'playlist');

    assert.equal(parseDurationToSeconds('49:11'), 2951);
    assert.equal(parseDurationToSeconds('48:37'), 2917);

    const m3u = buildM3UPlaylist(store.files, 'https://andredrive.example', link.token);
    assert.ok(m3u.startsWith('#EXTM3U\n'));
    assert.ok(m3u.includes('#EXTINF:2951 '), 'M3U #EXTINF must contain exact duration in seconds (2951)');
    assert.ok(
      m3u.includes('tvg-logo="https://andredrive.example/api/tmdb/image?url='),
      'M3U tvg-logo must be an absolute https:// URL'
    );
    assert.ok(m3u.includes('Tausend Meilen Staub S01E01'));
    assert.ok(
      m3u.includes(
        `https://andredrive.example/media/${link.token}/file-4b2bbc107af9/Tausend%20Meilen%20Staub%20S01E01.mp4`
      )
    );
  });

  it('produces valid 32-char hex Jellyfin GUIDs and PKZIP archives', () => {
    const guid = jellyHexId('file:file-4b2bbc107af9');
    assert.match(guid, /^[0-9a-f]{32}$/);
    const dashed = `${guid.slice(0, 8)}-${guid.slice(8, 12)}-${guid.slice(12, 16)}-${guid.slice(16, 20)}-${guid.slice(20)}`;
    assert.equal(normalizeJellyId(dashed), guid);

    const zip = createZipArchive([
      { name: 'hello.txt', data: Buffer.from('AndreDrive Test', 'utf-8') },
    ]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50); // PK\x03\x04
    assert.ok(zip.includes(Buffer.from('hello.txt', 'utf-8')));
  });

  it('infers categories from mime types and filenames', () => {
    assert.equal(inferCategoryFromMimeAndName('video/mp4', 'Show.S02E05.1080p.mp4', 'auto'), 'series');
    assert.equal(inferCategoryFromMimeAndName('video/mp4', 'Feature.Film.2026.mp4', 'auto'), 'movie');
    assert.equal(inferCategoryFromMimeAndName('audio/mpeg', 'Track01.mp3', 'auto'), 'music');
    assert.equal(inferCategoryFromMimeAndName('application/octet-stream', 'SuperMarioWorld.sfc', 'auto'), 'game');
  });

  it('persists folders, files, and share links per account across logout, login, and disk reloads, and restores client vault non-destructively', () => {
    const tmpFile = path.join(os.tmpdir(), `andredrive-test-${Date.now()}.json`);
    try {
      const store1 = new AndreDriveStore(tmpFile);
      store1.createFolder('Persönliches Archiv', null);
      store1.createShareLink('file', 'file-4b2bbc107af9');
      assert.equal(store1.folders.length, 5);
      assert.equal(store1.links.length, 1);

      // Logout and re-login
      store1.logout();
      assert.equal(store1.isLoggedIn, false);
      store1.login({ id: 'usr-andre-1', name: 'Andre', email: 'LPAndreU97@gmail.com' });
      assert.equal(store1.isLoggedIn, true);
      assert.equal(store1.folders.length, 5);
      assert.equal(store1.links.length, 1);

      // Reload from disk in a new store instance
      const store2 = new AndreDriveStore(tmpFile);
      assert.equal(store2.isLoggedIn, true);
      assert.equal(store2.folders.length, 5);
      assert.ok(store2.folders.some((f) => f.name === 'Persönliches Archiv'));
      assert.equal(store2.links.length, 1);

      // Restore client vault with a real video file
      const restoredCount = store2.restoreClientVault({
        files: [
          {
            id: 'file-ce0f1c0a7ebe',
            name: 'Tausend Meilen Staub S01E04.mp4',
            size: 236190158,
            mime: 'video/mp4',
            kind: 'series',
            folder: 'd2',
            created: new Date().toISOString(),
            starred: true,
            series: 'Tausend Meilen Staub',
            season: 1,
            episode: 4,
            hls: 'ready',
          },
        ],
      });
      assert.equal(restoredCount, true);
      assert.equal(store2.files.length, 1);
      assert.ok(store2.files.some((f) => f.id === 'file-ce0f1c0a7ebe'));
      assert.equal(store2.files[0].duration, '48:29');
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it('searches TMDB metadata for Tausend Meilen Staub (Rawhide) and Inception with full details', async () => {
    const parsed = extractQueryFromFilename({
      id: 'file-4b2bbc107af9',
      name: 'Tausend Meilen Staub S01E01.mp4',
      size: 572116508,
      mime: 'video/mp4',
      kind: 'series',
      created: '2026-04-19T12:25:52.712Z',
      starred: false,
      folder: 'fld-10e550cf976f',
    });
    assert.equal(parsed.season, 1);
    assert.equal(parsed.episode, 1);

    const rawhideResults = await searchTmdbMetadata('series', 'Tausend Meilen Staub', '');
    assert.ok(rawhideResults.length > 0);
    assert.equal(rawhideResults[0].title, 'Tausend Meilen Staub');

    const searchItems = await searchTmdbMetadata('movie', 'Inception', '');
    assert.ok(searchItems.length > 0);
    const inception = searchItems.find((item) => item.title === 'Inception');
    assert.ok(inception, 'Expected Inception in TMDB search results');
    assert.equal(inception.year, '2010');

    const detailRes = await fetchTmdbDetails('movie', inception.id, 1, 1, '');
    assert.ok(detailRes);
    assert.equal(detailRes.metadata.title, 'Inception');
    assert.equal(detailRes.metadata.director, 'Christopher Nolan');
    assert.ok(detailRes.metadata.cast?.includes('Leonardo DiCaprio'));
    assert.equal(detailRes.metadata.imdb_id, 'tt1375666');
  });
});


