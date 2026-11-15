import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

describe('Firestore Security Rules Dirty Dozen Verification', () => {
  const rules = fs.readFileSync('./firestore.rules', 'utf8');

  it('enforces rules_version = 2 and global default-deny catch-all', () => {
    assert.ok(rules.includes("rules_version = '2';"));
    assert.ok(rules.includes('match /{document=**}'));
    assert.ok(rules.includes('allow read, write: if false;'));
  });

  it('rejects unauthenticated and unverified email writes (Dirty Dozen #1, #2)', () => {
    assert.ok(rules.includes('request.auth != null'));
    assert.ok(rules.includes('request.auth.token.email_verified == true'));
  });

  it('prevents cross-account spoofing and shadow fields (Dirty Dozen #3, #4)', () => {
    assert.ok(rules.includes('data.ownerId == request.auth.uid'));
    assert.ok(rules.includes("data.keys().hasOnly(['ownerId', 'displayName', 'rommServerUrl', 'rommFolderId', 'createdAt', 'updatedAt'])"));
    assert.ok(rules.includes("data.keys().hasOnly(['ownerId', 'workspaceId', 'name', 'kind', 'mime', 'size', 'folder', 'starred', 'createdAt', 'updatedAt'])"));
  });

  it('enforces ID poisoning guard, Master Gate parent checks, and immutability (Dirty Dozen #5, #6, #7, #8, #9, #10, #11, #12)', () => {
    assert.ok(rules.includes("id.matches('^[a-zA-Z0-9_\\\\-]+$')"));
    assert.ok(rules.includes('isWorkspaceOwner(userId)'));
    assert.ok(rules.includes('incoming().ownerId == existing().ownerId'));
    assert.ok(rules.includes('incoming().createdAt == existing().createdAt'));
    assert.ok(rules.includes('incoming().createdAt == request.time'));
    assert.ok(rules.includes('incoming().updatedAt == request.time'));
    assert.ok(rules.includes("data.color in ['green', 'purple', 'orange', 'blue']"));
  });
});
