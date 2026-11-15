import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

let tunnelProcess: ChildProcess | null = null;
let publicTunnelUrl: string | null = null;
let customDomain: string | null = null;

const TUNNEL_DIR = path.join(process.cwd(), '.andredrive-storage');
const TUNNEL_LOG_PATH = path.join(TUNNEL_DIR, 'tunnel.log');
const TUNNEL_INFO_PATH = path.join(TUNNEL_DIR, 'tunnel.json');

// Load persisted custom domain or cached tunnel info
try {
  if (fs.existsSync(TUNNEL_INFO_PATH)) {
    const saved = JSON.parse(fs.readFileSync(TUNNEL_INFO_PATH, 'utf-8'));
    if (saved.customDomain) customDomain = saved.customDomain;
    if (saved.publicUrl) publicTunnelUrl = saved.publicUrl;
  }
} catch {
  // Ignore
}

function persistTunnelState() {
  try {
    if (!fs.existsSync(TUNNEL_DIR)) {
      fs.mkdirSync(TUNNEL_DIR, { recursive: true });
    }
    fs.writeFileSync(
      TUNNEL_INFO_PATH,
      JSON.stringify(
        {
          publicUrl: publicTunnelUrl,
          customDomain,
          activeOrigin: getPublicOrigin(),
          updated: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch {
    // Ignore
  }
}

export function getPublicOrigin(req?: { headers?: Record<string, any>; protocol?: string; get?: (header: string) => string | undefined }): string {
  // If the request is already reaching us via the public tunnel host, honor its host header
  if (req) {
    const rawHost =
      (req.headers?.['x-forwarded-host'] as string) ||
      (req.get ? req.get('host') : '') ||
      '';
    const proto =
      (req.headers?.['x-forwarded-proto'] as string) ||
      req.protocol ||
      'https';
    if (rawHost && (rawHost.includes('trycloudflare.com') || (customDomain && rawHost.includes(new URL(customDomain).host)))) {
      return `${proto}://${rawHost}`;
    }
  }

  if (customDomain && customDomain.startsWith('http')) {
    return customDomain.replace(/\/+$/, '');
  }
  if (publicTunnelUrl && publicTunnelUrl.startsWith('http')) {
    return publicTunnelUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}

export function setCustomDomain(url: string | null): void {
  if (!url || !url.trim()) {
    customDomain = null;
  } else {
    let clean = url.trim();
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = `https://${clean}`;
    }
    customDomain = clean.replace(/\/+$/, '');
  }
  persistTunnelState();
}

export function getCustomDomain(): string | null {
  return customDomain;
}

export function getPublicTunnelUrl(): string | null {
  return publicTunnelUrl;
}

export function getTunnelStatus() {
  return {
    running: Boolean(tunnelProcess && !tunnelProcess.killed),
    publicUrl: publicTunnelUrl,
    customDomain,
    effectivePublicOrigin: getPublicOrigin(),
  };
}

export function startCloudflareTunnel(port: number = 3000): void {
  if (tunnelProcess && !tunnelProcess.killed) return;

  const binaryCandidates = [
    path.join(process.cwd(), 'bin', 'cloudflared'),
    '/tmp/cloudflared',
    'cloudflared',
  ];
  const binaryPath = binaryCandidates.find((p) => {
    try {
      return fs.existsSync(p) || p === 'cloudflared';
    } catch {
      return false;
    }
  });

  if (!binaryPath) {
    console.warn('[Tunnel] cloudflared binary not found, skipping quick tunnel');
    return;
  }

  if (!fs.existsSync(TUNNEL_DIR)) {
    fs.mkdirSync(TUNNEL_DIR, { recursive: true });
  }

  try {
    // Clear old log to avoid picking up stale tunnel URLs
    try {
      if (fs.existsSync(TUNNEL_LOG_PATH)) {
        fs.unlinkSync(TUNNEL_LOG_PATH);
      }
    } catch {
      // Ignore
    }

    const proc = spawn(
      binaryPath,
      [
        'tunnel',
        '--protocol',
        'http2',
        '--url',
        `http://localhost:${port}`,
        '--no-autoupdate',
        '--logfile',
        TUNNEL_LOG_PATH,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    tunnelProcess = proc;

    const parseOutput = (chunk: Buffer | string) => {
      const text = chunk.toString();
      const match = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/.exec(text);
      if (match && match[0] !== publicTunnelUrl) {
        publicTunnelUrl = match[0];
        persistTunnelState();
        console.log(`\n======================================================`);
        console.log(`[Tunnel] GLOBALE ÖFFENTLICHE SERVER-URL: ${publicTunnelUrl}`);
        console.log(`[Tunnel] Jellyfin (Streamyfin/Moonfin): ${publicTunnelUrl}/jellyfin`);
        console.log(`======================================================\n`);
      }
    };

    proc.stdout?.on('data', parseOutput);
    proc.stderr?.on('data', parseOutput);

    // Poll the logfile every 1s until the URL is found
    const pollInterval = setInterval(() => {
      if (fs.existsSync(TUNNEL_LOG_PATH)) {
        try {
          const logContent = fs.readFileSync(TUNNEL_LOG_PATH, 'utf-8');
          const match = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/.exec(logContent);
          if (match && match[0] !== publicTunnelUrl) {
            publicTunnelUrl = match[0];
            persistTunnelState();
            console.log(`\n======================================================`);
            console.log(`[Tunnel] GLOBALE ÖFFENTLICHE SERVER-URL: ${publicTunnelUrl}`);
            console.log(`[Tunnel] Jellyfin (Streamyfin/Moonfin): ${publicTunnelUrl}/jellyfin`);
            console.log(`======================================================\n`);
          }
        } catch {
          // Ignore read errors
        }
      }
    }, 1000);

    proc.on('close', (code) => {
      console.log(`[Tunnel] cloudflared closed with code ${code}`);
      tunnelProcess = null;
      clearInterval(pollInterval);
      // Auto-restart after 4s if unexpected termination
      setTimeout(() => startCloudflareTunnel(port), 4000);
    });
  } catch (err) {
    console.error('[Tunnel] Failed to spawn cloudflared:', err);
  }
}
