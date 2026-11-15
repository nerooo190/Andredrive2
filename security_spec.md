# AndreDrive Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Workspace Ownership Invariant**: Every `/workspaces/{userId}` document must have `ownerId == request.auth.uid` and `userId == request.auth.uid`, with `request.auth.token.email_verified == true`.
2. **Master Gate Relational Sync Invariant**: A `/workspaces/{userId}/files/{fileId}` or `/workspaces/{userId}/folders/{folderId}` document can only be read, created, updated, or deleted if the parent `/workspaces/{userId}` document exists and its `ownerId == request.auth.uid`.
3. **Immutability Invariant**: `ownerId`, `workspaceId`, and `createdAt` can never be modified after document creation.
4. **Temporal Integrity Invariant**: `createdAt` and `updatedAt` must strictly equal `request.time`.
5. **PII Isolation Invariant**: No raw PII (emails, phone numbers, addresses) is stored in `/workspaces/{userId}` or its subcollections, and all reads require owner identity verification.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Write**: Create `/workspaces/usr_1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Create `/workspaces/usr_1` with `email_verified: false` -> `PERMISSION_DENIED`.
3. **Cross-Account Identity Spoofing**: User `usr_2` creates `/workspaces/usr_1` with `ownerId: "usr_1"` -> `PERMISSION_DENIED`.
4. **Shadow/Ghost Field Injection**: Create `/workspaces/usr_1` with extra field `isAdmin: true` -> `PERMISSION_DENIED`.
5. **ID Poisoning (>128 chars or invalid regex)**: Create `/workspaces/usr_1/files/bad$id!` -> `PERMISSION_DENIED`.
6. **Orphaned Subcollection Write**: Create `/workspaces/usr_1/files/f1` when `/workspaces/usr_1` does not exist -> `PERMISSION_DENIED`.
7. **Owner Mutation on Update**: Update `/workspaces/usr_1` changing `ownerId` to `"usr_2"` -> `PERMISSION_DENIED`.
8. **CreatedAt Mutation on Update**: Update `/workspaces/usr_1/files/f1` changing `createdAt` -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Create `/workspaces/usr_1` with past/future `createdAt` instead of `request.time` -> `PERMISSION_DENIED`.
10. **Value Poisoning (Oversized String)**: Update `/workspaces/usr_1/files/f1` setting `name` to a 500-char string (limit 255) -> `PERMISSION_DENIED`.
11. **Invalid Enum Value**: Create `/workspaces/usr_1/folders/fld1` with `color: "red"` (not in `['green', 'purple', 'orange', 'blue']`) -> `PERMISSION_DENIED`.
12. **Unauthorized Cross-Tenant List Scraping**: User `usr_2` lists `/workspaces/usr_1/files` -> `PERMISSION_DENIED`.
