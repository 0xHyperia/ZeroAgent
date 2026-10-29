# Verified images and bounded file metadata

Verified PNG/JPEG/GIF/WebP originals <=8 MiB enter `vision_ready`. They have no
OCR Text/Segments. The model boundary re-fetches and hashes owned original bytes,
then constructs `image_url` data URLs without decoding pixels on the host.
Aggregate model input remains <=32 MiB; oversized images stay uploaded and need
another explicit capability. Models lacking vision must fail honestly. Image
references never invent source line citations; text/content APIs reject images.

`parse_truncated` is a small persisted summary. Lists do not need to fetch or
detoast multi-MiB parser journals to show partial extraction. File/project lists
and download ownership checks use metadata projections; parser selection loads
only lease/state summaries before an individual owned Get. Terminal journals
remove download payloads but retain IDs/hashes/status. Official Text/Segments
remain until deletion.

Large text/CSV originals remain verified canonical resources even when they
exceed extraction/context limits. Response-only `workspace_loadable` checks the
explicit adapter's read-only health and object-store configuration once per
metadata response. A disabled adapter fails closed and does not allocate a VM.
This flag never changes parser states or claims extracted text/OCR exists.

An owned verified original can be referenced while uploaded/processing/failed,
or when its extracted text exceeds the 512 KiB inline budget, if this capability
is available. The provider receives only a controlled metadata description and
must call `load_uploaded_file`; it never receives all raw bytes as prompt text.
That tool rechecks the current session, running Run lease/attempt, executing
operation and owned workspace, downloads and verifies the canonical source SHA,
and uploads bytes in bounded frames. No signed object URL or storage credential
enters the VM. Deletion during loading cancels the Run and queues VM cleanup.
Previously loaded workspace copies may remain until their VM is terminated;
source deletion does not retroactively retract an already completed analysis.

Parser and conversation allocations share one account/UTC-day counter, default
3600 seconds. Each five-minute allocation uses a stable create operation ID and
records a non-refundable reservation before SDK dispatch, including uncertain
outcomes. Rechecking the same ID on a later day never charges it again.
