# Experimental personal Google Earth Engine

## 本地 Agent 模式

当前实验推荐使用 [LOCAL_AGENT.md](LOCAL_AGENT.md) 的本地入口和 Desktop OAuth 配置。下方 Web OAuth 配置描述旧的统一后端运行方式，不能用于宣称“用户数据仅存在用户电脑”。Agent GEE worker 已取消服务账号回退；旧系统记录保持可读，不能自动换用当前用户身份重放。

The following Web deployment remains disabled by default. The restricted Python runner is **not a sandbox for untrusted public users**. Basic static layers use the system service account only in the legacy unified backend; the local Agent entry disables that Basic backend. Agent GEE execution requires user OAuth in either entry. These features never share, move, overwrite or delete an Earth Engine asset.

## Worktree and existing data

Branch `codex/gee-personal-upload`, directory `.worktrees/gee-personal-upload`, based on `532c265`. The six pre-existing uncommitted baseline files were copied into the experiment, leaving the originals alone. Ignored `outputs/gee-personal-upload/baseline.json` and `before/` identify inherited changes.

The original `.env`, credentials and `harness/state` were not copied. Never point experimental runtime storage at the original state directory. Browser AOI storage on port 3313 is separate from port 3000; original AOIs remain on their original origin. This feature does not migrate the AOI library into Google accounts.

## User login

Users choose **Sign in with Google and connect GEE**, select their Google account and grant read-only Earth Engine access in one authorization flow. They do not create/upload an OAuth client, provide a client secret, download client JSON or edit `.env`. After login they enter their GEE project and, when uploading, an existing bucket in the frontend. Upload write permission is requested only when needed.

Google identity, granted GEE access and project verification remain separate states. Partial grants offer **Connect Earth Engine**, without claiming a completed connection. Cancelled/failed callbacks return to the application with retry guidance. If the application login service is unavailable, the frontend shows a disabled login and **Retry**, without deployment instructions or credential fields.

## Application deployment (maintainers only)

The following is a one-time application deployment prerequisite, not an end-user login workflow. A real registered Web OAuth client remains necessary; UI changes cannot replace its credentials or Google consent configuration. The client secret and token-encryption key stay on the backend.

1. Use Python 3.12 and install this worktree's `requirements.txt` in its own environment; install frontend dependencies here. Development used an ignored local Python environment referencing existing packages read-only, and an ignored frontend dependency junction with Vite caches directed into this worktree. These are local conveniences, not deployment artifacts.
2. Fill this worktree's own `.env` using `.env.example`. Existing system service-account/model settings are still deployment prerequisites; an absolute path can reference an existing key read-only. No real configuration belongs in Git.
3. Configure a **Google OAuth Web application** client, consent screen and test users. The example redirect is exactly `http://127.0.0.1:3313/api/personal/oauth/callback`. Consent-screen publication/verification and all account consent remain operator actions.
4. Configure server-only values:

   ```dotenv
   SATGPT_PERSONAL_ENABLED=true
   GOOGLE_OAUTH_CLIENT_ID=<web-client-id>
   GOOGLE_OAUTH_CLIENT_SECRET=<web-client-secret>
   SATGPT_PUBLIC_ORIGIN=http://127.0.0.1:3313
   SATGPT_TOKEN_ENCRYPTION_KEY=<independent-fernet-key>
   FRONTEND_PORT=3313
   AGENT_PORT=8313
   ```

   Generate the Fernet key once:

   ```powershell
   & harness/.venv/Scripts/python.exe -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
   ```

   Store it securely, separately from database backups. Do not paste it into chat, screenshots or Git. Losing/changing it requires reconnecting accounts; there is no silent key replacement/token deletion.
5. Start the existing unified backend and frontend from this worktree, using the separate ports. HTTP public origins are accepted only on loopback; other origins require HTTPS. Callback origin is fixed configuration, not incoming Host/forwarded headers. Existing local/trusted access restrictions remain.
6. Open **Google / GEE → Sign in with Google and connect GEE**. The first login requests identity and read-only GEE scopes together. Enter a registered, API-enabled GEE project that the account has permission to use, then **Verify and save**. Project verification performs an EE computation. Google sign-in, granted EE access and verified project are distinct states.
7. Uploading additionally requires **Authorize uploads** and an existing Cloud Storage bucket. Scopes do not grant IAM rights: account/source-object/import/asset permissions must be configured externally. Bucket access is exercised during transfer, not certified by project verification. Storage usage may incur charges. The application does not create cloud resources, enable billing or modify IAM.

## Use personal data

Browse the configured project's root, folders and collections with pagination. An explicit shared/legacy asset ID can be added (`users/...` is normalized). This does not enumerate every Cloud project or discover every shared asset.

**Verify data** registers an Image, ImageCollection or Table. In Intelligent analysis, select data for the current conversation's next request. At most 20 inputs are accepted. Removing an input affects future requests, not saved tasks. **Display in current extent** creates a normal result layer through the existing worker and Current layers, without changing AOI or invoking the model. Tables use image styling; collections require explicit start/exclusive-end dates and median/mosaic selection.

Tools receive the frozen selected metadata and `analysis_inputs[id]` EE objects. Metadata is data, never instructions. Public datasets remain available; models do not guess private IDs or gain asset-management/export/file permissions.

Each task captures owner, connection revision, project, inputs and AOI before queuing. Selection/account/project changes cannot redirect it. Replays use saved project and inputs with fresh permission/update checks. Reconnecting the same identity can reauthorize a replay against that original project; old queued connection revisions are rejected. Changed/deleted/unreadable assets require refreshing/reselecting data. Remote assets are not claimed to be immutable snapshots.

## Uploads

First version: one GeoTIFF (`.tif/.tiff`) or EPSG:4326/CRS84 GeoJSON Feature/FeatureCollection with ordinary point, line, polygon or corresponding Multi geometries. This is separate from the existing 2 MB polygon-only AOI import.

Default server limits: raster 100 MiB; vector 10 MiB; total staging 1 GiB. GeoJSON limits: 10,000 features, 100,000 vertices, 100 scalar columns. GeoTIFF validation requires georeferencing, a valid extent and unique supported band names, and reads metadata without resampling, pixel rewriting or changing declared NoData.

GeoJSON is converted into CSV with `.geo` and explicit string/integer/numeric column overrides, then imported with TableManifest. Null geometries, GeometryCollections, nested/boolean properties, mixed column types, reserved names and invalid coordinates are explicitly rejected. The supported EE CSV schema has no lossless boolean override; intentionally convert booleans to numbers or strings first. Shapefile ZIP, arbitrary CSV, NetCDF, directory batches and large browser-upload resume are deferred.

The submit form shows account, project, destination asset and bucket. Actual streamed bytes and aggregate staging size are bounded. A separate bounded worker uploads to a unique owner/upload GCS object and starts import with a fixed request ID and overwrite disabled. Durable records retain hash, destination and Operation. A lost import reply is reconciled against the unique task description before retrying the deduplicated request; ambiguous recovery retains source data and reports the problem.

Only a completed Operation plus readable registered asset becomes **ready**. File transfer completion alone does not. Upload cancellation is independent of **Stop response**, and cancellation intent is distinct from remote confirmation. Google disconnect cannot guarantee an already-running import stops: reconnect the original identity and explicitly resume/poll it. Retry/resume preserve destination, project and bucket. Staging cleanup waits for known remote completion, checks app-owned GCS metadata/generation and never deletes the EE asset.

## Architecture and compatibility

- `harness/app/personal/`: OAuth, encrypted SQLite token/connection storage, session-derived ownership, typed management operations, uploads and loopback credential broker.
- Reuses TaskController with per-owner history, SDK home, events and previews. Personal chats share one executor; replays share a two-process gate. Guest/system records remain readable, but new Agent tasks require user OAuth. Limits: eight personal controllers per process, 64 queued/active personal analyses, eight active uploads, one independent upload-processing thread.
- Browser receives only opaque HttpOnly application session cookies. Refresh tokens remain encrypted in the backend; workers get short-lived tokens over a capability-authenticated loopback channel. Model keys/OAuth secrets/encryption keys are removed from workers; personal workers also omit system-account credentials. Tokens/capabilities are not model parameters or replay/history fields.
- Owner checks cover history, task polling/cancellation/SSE, datasets, uploads and previews. Authenticated writes enforce CSRF/Origin. Identity changes clear agent map groups, remount chat and discard in-memory selections without recreating the shared map.
- Guest/system history stays in its original workspace; it is not assigned to the first Google login. AOI formats and static-layer APIs/algorithms remain unchanged. Version 1 system recipes remain readable, with no service-account execution or silent reassignment to a user. Version 2 adds non-secret execution provenance for personal replay.
- Sign out removes this browser session, without deleting history or revoking Google permission. Disconnect invalidates execution and stops local chat/replay processes. Revoke additionally requests Google grant revocation. Cloud imports may continue until reconciled.

## Verification boundary and deferred work

The 2026-11-14 login UX adjustment is recorded separately in ignored `outputs/google-login-20261114/verification.json`, including necessary test/build results and comparison to its existing working baseline. That change does not certify real Google consent, token refresh or account connection when the application client has not yet been configured.

Only necessary checks are run in this experiment. Full validation is required **before remote repository synchronization/push**, not a local commit. No implementation commit or push is authorized.

See ignored `outputs/gee-personal-upload/verification.json` for current automated results and original-tree comparison. Page evidence uses a **mock account and mock cloud**, with a disposable sample file and the actual frontend/API upload-to-ready/selection flow. It does not verify Google authorization or EE ingestion. A dummy Mapbox token means that page check does not certify basemap rendering, GEE tiles or model execution. Temporary services and the test tab are stopped/closed after inspection.

Pending before cloud synchronization:

- Real Google callback/denial/partial scopes/refresh/revocation, project/IAM failures and proxy behavior using an operator-controlled account.
- Real private Image/Table/collection analysis and original-identity replay; CSV typing, GeoTIFF NoData/bands and GCS source-object read permissions.
- Real import cancellation, quota failures, lost-response reconciliation and process restart during every upload stage; bucket permissions and cleanup generation checks.
- Full frontend, Python, Harness and Node suites, final production build, sustained identity/session concurrency, stale map responses, old system/AOI data and desktop layout regressions.
- Clean Windows dependency installation, plus Linux/container packaging if deployment requires it.
- Any public multi-user deployment needs a separate execution-isolation/access-control design and review.
