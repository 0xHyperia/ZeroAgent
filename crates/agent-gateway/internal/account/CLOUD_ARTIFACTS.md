# Durable generated artifacts

`Service.PublishCloudArtifact(ctx, userID, CloudArtifactPublication)` checks the
live original session, current running Run lease/attempt, executing semantic
`publish_artifact` operation and its arguments, plus the owned conversation
workspace. Models supply only path/name/optional MIME/family ID. Go injects the
resource and execution binding. Cancelling Runs cannot publish ready versions.

Size and SHA256 come from scoped SDK inspection. The service downloads <=32 MiB
in <=1 MiB frames and verifies the complete digest, then writes a new canonical
S3 object and reads its entire body back to verify size/hash/type/owner metadata.
Only an atomic, still-authorized ready commit gives `download_url`. A VM path is
never a deliverable. CSV/Markdown can be generated offline with Python's standard
library; the storage model accepts generic bytes and MIME types.

Families hold immutable numbered versions with source Run/tool-operation facts.
Identical operation retries return the same version; changed requests conflict.
Pending/unknown retries return the original state with `UnknownOutcomeError`
instead of repeating effects. Limits: 32 MiB/version, 256 MiB non-deleted bytes,
500 live/staged/unknown versions/account, 100 versions/family. This quota is
separate from the original-file library. Old versions remain available when a
new version is created. Conversation deletion does not cascade published files.

The family's conversation ID is creation provenance, not an authorization
boundary. Another conversation of the same account may load an owned ready
version into a fresh VM and publish the next version in the same family. Each
version records its actual source conversation/Run. `load_uploaded_file` accepts
exactly one of `file_id` and `artifact_version_id`, verifies canonical S3 bytes
and SHA before transfer, and independently enforces session/Run/tool/workspace
fences. Deleted, unknown and foreign versions cannot be loaded.

User messages may contain `{type:"artifact_reference",version_id:UUID}`. The
server replaces every client metadata field with the immutable owned snapshot
`name,mime,size,family_id,number,sha256`. It converts this internal part into a
metadata-only model resource description directing the controlled load tool;
the reference itself is never sent as an unsupported provider part. File and
artifact references share the eight-item message bound. Edit branches preserve
the canonical snapshot, and use always rechecks current deletion/ownership.

Public authenticated APIs:

- `GET /api/web-chat/artifacts?conversation_id=...&family_id=...&before=...&limit=50`
- `GET /api/web-chat/artifacts/versions/{id}`
- `GET /api/web-chat/artifacts/versions/{id}/download`
- `DELETE /api/web-chat/artifacts/{family_id}`

Lists return `{versions, next_cursor}`. The default page size is 50, bounded to
1–100; an empty cursor means the result has reached its actual end. Account and
conversation lists are ordered by immutable `(created_at DESC, id DESC)`, with a
strict keyset comparison after the prior page. The opaque `before` version UUID
is resolved only within the same owner and selected conversation/family scope.
Tombstones retain their ordering key, so deleting the last item of a prior page
does not strand older artifacts. Newer concurrent publications appear on refresh;
they do not reorder already traversed pages. The client appends actual pages and
merges family cards without claiming a truncated page is the entire library.
Family version selectors request up to the current 100-version family bound.

Downloads verify canonical bytes before HTTP 200, force attachment, set
nosniff/CSP sandbox and recheck ownership/deletion. Clients request
`Accept: application/octet-stream` to use the Native raw-byte pull bridge.
No S3 URL, object key or management credential is exposed. Public lists exclude
private journals, which store IDs/hashes/states rather than downloaded data.
After the version durably records source size/SHA, SDK inspection can be
acknowledged. Each downloaded chunk is acknowledged only after its private
terminal metadata commits. The adapter retains a non-executable tombstone;
unknown/executing results are not acknowledged. ACK failure never changes an
already committed outcome. A publication interrupted before canonical storage
is ready remains unknown rather than replaying a retired transfer or claiming
that in-memory bytes survived a process crash.

Deletion atomically tombstones every version; late ready commits cannot revive
them. A delayed acknowledged PUT causes a second cleanup of its late bytes.
Unknown write completion stays `deleting/late_write_unknown`, retains quota and
needs provider/operator reconciliation; DELETE success alone cannot prove a late
PUT impossible. `ReconcileCloudArtifacts` retries deletion/stale unpublished
cleanup and must be called by application maintenance. Original upload keys are
separate and never overwritten. Backups require both metadata tables and the
`accounts/.../artifacts/` object namespace, not only a database snapshot.

Memory/real isolated PostgreSQL contracts and real local SDK/S3 HTTP fixtures
cover versions, owner/lease fences, CSV transfer, corruption and delayed PUT
deletion. These do not accept live E2B, real cloud S3, paid generation or actual
backup restoration. Deployment retention/archival, fixed template generation
dependencies and live acceptance
remain explicit follow-up requirements.
