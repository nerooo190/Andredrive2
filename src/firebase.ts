import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData.map((provider) => ({
          providerId: provider.providerId,
          displayName: provider.displayName,
          email: provider.email,
          photoUrl: provider.photoURL,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

function sanitizeId(rawId: string): string {
  return String(rawId || 'item')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
}

export interface SyncableLibrary {
  files?: Array<{
    id: string;
    name: string;
    kind: string;
    mime: string;
    size: number;
    folder: string | null;
    starred: boolean;
    created?: string;
    series?: string;
    season?: number;
    episode?: number;
    quality?: string;
    duration?: string;
    image?: string;
    hls?: string;
    metadata?: Record<string, unknown>;
  }>;
  folders?: Array<{
    id: string;
    name: string;
    parent: string | null;
    color: 'green' | 'purple' | 'orange' | 'blue';
  }>;
  links?: Array<{
    token: string;
    type: string;
    target: string;
    created: string;
  }>;
  categories?: Array<{
    id: string;
    name: string;
    icon: string;
    builtin: boolean;
  }>;
}

const VAULT_PREFIX = 'andredrive:permanent-vault:v2:';

const REMOVED_PLACEHOLDER_IDS = new Set<string>([
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

function isPlaceholderFile(id: string | undefined | null): boolean {
  if (!id) return false;
  return REMOVED_PLACEHOLDER_IDS.has(id) || /^demo\d+$/i.test(id);
}

export function saveToPermanentVault(userId: string, library: SyncableLibrary): void {
  const key = `${VAULT_PREFIX}${userId || 'usr-andre-1'}`;
  try {
    const existingRaw = localStorage.getItem(key);
    const existing: SyncableLibrary = existingRaw ? JSON.parse(existingRaw) : {};

    // Merge files non-destructively so existing user files in the vault are kept unless explicitly removed or placeholders
    const fileMap = new Map<string, NonNullable<SyncableLibrary['files']>[number]>();
    for (const f of existing.files || []) {
      if (f && f.id && !isPlaceholderFile(f.id)) fileMap.set(f.id, f);
    }
    for (const f of library.files || []) {
      if (f && f.id && !isPlaceholderFile(f.id)) fileMap.set(f.id, f);
    }

    const folderMap = new Map<string, NonNullable<SyncableLibrary['folders']>[number]>();
    for (const fld of existing.folders || []) {
      if (fld && fld.id) folderMap.set(fld.id, fld);
    }
    for (const fld of library.folders || []) {
      if (fld && fld.id) folderMap.set(fld.id, fld);
    }

    const linkMap = new Map<string, NonNullable<SyncableLibrary['links']>[number]>();
    for (const lnk of existing.links || []) {
      if (lnk && lnk.token) linkMap.set(lnk.token, lnk);
    }
    for (const lnk of library.links || []) {
      if (lnk && lnk.token) linkMap.set(lnk.token, lnk);
    }

    const payload: SyncableLibrary = {
      files: Array.from(fileMap.values()),
      folders: Array.from(folderMap.values()),
      links: Array.from(linkMap.values()),
      categories: library.categories || existing.categories || [],
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors
  }
  void syncWorkspaceToFirestore(library);
}

export async function loadFromPermanentVault(userId: string): Promise<SyncableLibrary | null> {
  const key = `${VAULT_PREFIX}${userId || 'usr-andre-1'}`;
  let localVault: SyncableLibrary | null = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      localVault = JSON.parse(raw) as SyncableLibrary;
      if (localVault && Array.isArray(localVault.files)) {
        localVault.files = localVault.files.filter((f) => f && f.id && !isPlaceholderFile(f.id));
      }
    }
  } catch {
    localVault = null;
  }

  // Also check Firestore if authenticated with Firebase
  const currentUser = auth.currentUser;
  if (currentUser && currentUser.emailVerified) {
    const uid = sanitizeId(currentUser.uid);
    try {
      const [foldersSnap, filesSnap] = await Promise.all([
        getDocs(collection(db, 'workspaces', uid, 'folders')),
        getDocs(collection(db, 'workspaces', uid, 'files')),
      ]);
      const firestoreFolders = foldersSnap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: String(data.name || 'Ordner'),
          parent: data.parent ? String(data.parent) : null,
          color: (['green', 'purple', 'orange', 'blue'].includes(data.color)
            ? data.color
            : 'green') as 'green' | 'purple' | 'orange' | 'blue',
        };
      });
      const firestoreFiles = filesSnap.docs
        .filter((d) => !isPlaceholderFile(d.id))
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: String(data.name || 'Datei'),
            kind: String(data.kind || 'movie'),
            mime: String(data.mime || 'video/mp4'),
            size: Number(data.size) || 0,
            folder: data.folder ? String(data.folder) : null,
            starred: Boolean(data.starred),
            created: new Date().toISOString(),
          };
        });

      const mergedFiles = [...(localVault?.files || [])];
      const seenFiles = new Set(mergedFiles.map((f) => f.id));
      for (const ff of firestoreFiles) {
        if (!seenFiles.has(ff.id)) {
          mergedFiles.push(ff);
        }
      }

      const mergedFolders = [...(localVault?.folders || [])];
      const seenFolders = new Set(mergedFolders.map((f) => f.id));
      for (const fld of firestoreFolders) {
        if (!seenFolders.has(fld.id)) {
          mergedFolders.push(fld);
        }
      }

      return {
        files: mergedFiles,
        folders: mergedFolders,
        links: localVault?.links || [],
        categories: localVault?.categories || [],
      };
    } catch {
      return localVault;
    }
  }

  return localVault;
}

export async function removeFilesFromPermanentVault(userId: string, fileIds: string[]): Promise<void> {
  const key = `${VAULT_PREFIX}${userId || 'usr-andre-1'}`;
  const removeSet = new Set(fileIds);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as SyncableLibrary;
      parsed.files = (parsed.files || []).filter((f) => !removeSet.has(f.id));
      localStorage.setItem(key, JSON.stringify(parsed));
    }
  } catch {
    // Ignore localStorage error
  }

  const currentUser = auth.currentUser;
  if (currentUser && currentUser.emailVerified) {
    const uid = sanitizeId(currentUser.uid);
    for (const id of fileIds) {
      try {
        await deleteDoc(doc(db, 'workspaces', uid, 'files', sanitizeId(id)));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `workspaces/${uid}/files/${sanitizeId(id)}`);
      }
    }
  }
}

export async function syncWorkspaceToFirestore(library: SyncableLibrary): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.emailVerified) return;

  const uid = sanitizeId(currentUser.uid);
  const workspacePath = `workspaces/${uid}`;
  const workspaceRef = doc(db, 'workspaces', uid);

  try {
    const snap = await getDoc(workspaceRef);
    const displayName = (currentUser.displayName || currentUser.email || 'AndreDrive Nutzer').slice(0, 120);
    if (!snap.exists()) {
      await setDoc(workspaceRef, {
        ownerId: uid,
        displayName,
        rommServerUrl: 'http://steamdeck.local:8080',
        rommFolderId: 'd4',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existingData = snap.data();
      await setDoc(workspaceRef, {
        ownerId: existingData.ownerId,
        displayName,
        rommServerUrl: existingData.rommServerUrl || 'http://steamdeck.local:8080',
        rommFolderId: existingData.rommFolderId || 'd4',
        createdAt: existingData.createdAt,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, workspacePath);
  }

  if (Array.isArray(library.folders)) {
    const foldersCol = collection(db, 'workspaces', uid, 'folders');
    try {
      const existingFolders = await getDocs(foldersCol);
      const existingMap = new Map(existingFolders.docs.map((d) => [d.id, d.data()]));

      for (const fld of library.folders) {
        const fid = sanitizeId(fld.id);
        const fRef = doc(db, 'workspaces', uid, 'folders', fid);
        const prev = existingMap.get(fid);
        const validColor = ['green', 'purple', 'orange', 'blue'].includes(fld.color)
          ? fld.color
          : 'green';
        if (!prev) {
          await setDoc(fRef, {
            ownerId: uid,
            workspaceId: uid,
            name: String(fld.name || 'Ordner').slice(0, 120),
            parent: String(fld.parent || '').slice(0, 128),
            color: validColor,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else if (
          prev.name !== fld.name ||
          prev.parent !== String(fld.parent || '') ||
          prev.color !== validColor
        ) {
          await setDoc(fRef, {
            ownerId: prev.ownerId,
            workspaceId: prev.workspaceId,
            name: String(fld.name || 'Ordner').slice(0, 120),
            parent: String(fld.parent || '').slice(0, 128),
            color: validColor,
            createdAt: prev.createdAt,
            updatedAt: serverTimestamp(),
          });
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${workspacePath}/folders`);
    }
  }

  if (Array.isArray(library.files)) {
    const filesCol = collection(db, 'workspaces', uid, 'files');
    try {
      const existingFiles = await getDocs(filesCol);
      const existingMap = new Map(existingFiles.docs.map((d) => [d.id, d.data()]));

      for (const f of library.files) {
        const fileId = sanitizeId(f.id);
        const fRef = doc(db, 'workspaces', uid, 'files', fileId);
        const prev = existingMap.get(fileId);
        if (!prev) {
          await setDoc(fRef, {
            ownerId: uid,
            workspaceId: uid,
            name: String(f.name || 'Datei').slice(0, 255),
            kind: String(f.kind || 'other').slice(0, 64),
            mime: String(f.mime || 'application/octet-stream').slice(0, 128),
            size: Math.max(0, Math.min(1099511627776, Number(f.size) || 0)),
            folder: String(f.folder || '').slice(0, 128),
            starred: Boolean(f.starred),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else if (
          prev.name !== f.name ||
          prev.kind !== f.kind ||
          prev.folder !== String(f.folder || '') ||
          prev.starred !== Boolean(f.starred)
        ) {
          await setDoc(fRef, {
            ownerId: prev.ownerId,
            workspaceId: prev.workspaceId,
            name: String(f.name || 'Datei').slice(0, 255),
            kind: String(f.kind || 'other').slice(0, 64),
            mime: prev.mime,
            size: prev.size,
            folder: String(f.folder || '').slice(0, 128),
            starred: Boolean(f.starred),
            createdAt: prev.createdAt,
            updatedAt: serverTimestamp(),
          });
        }
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${workspacePath}/files`);
    }
  }
}

export async function signInWithGoogleAccount(): Promise<User> {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function signOutFirebaseAccount(): Promise<void> {
  if (auth.currentUser) {
    await signOut(auth);
  }
}

export { onAuthStateChanged };

